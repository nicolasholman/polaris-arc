/**
 * Chainlink's forwarder: every report it delivered to one of our two
 * receivers, and whether the receiver accepted it. Under
 * `cre workflow simulate --broadcast` a reverted onReport still reads as
 * success in the CLI; ReportProcessed.result is the truth.
 *
 * The forwarder is shared by every CRE consumer on the chain, so the query
 * asks HyperSync only for reports whose receiver topic is ours.
 */

import { indexer } from "envio";

import { settingsFor } from "../deployment.js";
import { withStore } from "../lib/store.js";
import { logId } from "../lib/util.js";

function receiversOf(chainId: number) {
  const a = settingsFor(chainId).addresses;
  return { collections: a.CollectionsReceiver, underwrite: a.UnderwritingReceiver } as const;
}

indexer.onEvent(
  {
    contract: "CreForwarder",
    event: "ReportProcessed",
    where: ({ chain }) => {
      const r = receiversOf(chain.id);
      return { params: { receiver: [r.collections as `0x${string}`, r.underwrite as `0x${string}`] } };
    },
  },
  async ({ event, context }) =>
    withStore(context, event, async (st) => {
      const { receiver, workflowExecutionId, reportId, result } = event.params;
      const r = receiversOf(st.m.chainId);
      const workflow = receiver === r.collections ? "collections" : receiver === r.underwrite ? "underwrite" : undefined;
      if (!workflow) return;
      st.keep("CreReport", {
        id: logId(st.m.txHash, st.m.logIndex),
        workflow,
        receiver,
        forwarder: st.m.srcAddress,
        workflowExecutionId,
        reportId,
        result,
        transmitter: st.m.from,
        timestamp: st.m.timestamp,
        blockNumber: st.m.blockNumber,
        txHash: st.m.txHash,
      });
      const p = await st.protocol();
      p.creReports += 1;
      if (!result) p.creReportsFailed += 1;
      (await st.protocolDay()).creReports += 1;
    }),
);
