import { beforeEach, describe, expect, it } from "vitest";

import { GET as paymentsGet } from "@/app/api/payments/route";
import { GET as payoutsGet } from "@/app/api/payouts/route";
import { periodSummary } from "@/lib/data/analytics";
import { getDb } from "@/server/db";

import { json, params, request, setupServer, type TestEnv } from "./helpers/env";
import { merchantWithKeys, type Merchant } from "./helpers/flows";

/**
 * One rule for every amount on the dashboard: AUSD micro-units, truncated to
 * cents the way the balance is. A 0.5% fee on $349 leaves 347.255 on chain:
 * the net is $347.25 (what the balance card shows), the fee $1.75, and the
 * 'today' chip is the balance's own change, never a cent off it.
 */

let env: TestEnv;
let merchant: Merchant;

beforeEach(async () => {
  env = setupServer();
  merchant = await merchantWithKeys();
});

async function pay(amountUnits: bigint, feeUnits: bigint, n: number) {
  const record = await getDb().merchants.findOne({ wallet: merchant.account.address.toLowerCase() });
  await getDb().payments.upsert({
    id: `pay_${n}`,
    merchantId: record!.id,
    kind: "now",
    sessionId: null,
    linkId: null,
    orderId: `HC-${n}`,
    description: `Halcyon order HC-${n}`,
    payer: "0x1111111111111111111111111111111111111111",
    amountUnits: amountUnits.toString(),
    feeUnits: feeUnits.toString(),
    txHash: `0x${n.toString(16).padStart(64, "0")}`,
    blockNumber: n,
    createdAt: new Date().toISOString(),
  });
}

describe("cents", () => {
  it("nets a payment the way the balance truncates it, and the fee makes up the rest", async () => {
    await pay(349_000_000n, 1_745_000n, 1);
    const list = (await json(await paymentsGet(request("GET", "/api/payments"), params({})))).body.data;
    expect(list[0]).toMatchObject({ amountCents: 349_00, netCents: 347_25, feeCents: 1_75, netUnits: "347255000" });
  });

  it("totals nets in micro-units before truncating, so the Payments summary matches the balance", async () => {
    await pay(349_000_000n, 1_745_000n, 1);
    await pay(349_000_000n, 1_745_000n, 2);
    const list = (await json(await paymentsGet(request("GET", "/api/payments"), params({})))).body.data;
    const summary = periodSummary(list, { days: 30 });
    // 2 × 347.255 = 694.51, not 2 × 347.25.
    expect(summary.net).toBe(694_51);
    expect(summary.gross - summary.net).toBe(summary.fees);
  });

  it("says the balance's own change today, agreeing with the card", async () => {
    await pay(349_000_000n, 1_745_000n, 1);
    // The wallet holds exactly what came in.
    env.chain.reads.balanceOf = () => 347_255_000n;
    const state = (await json(await payoutsGet(request("GET", "/api/payouts"), params({})))).body.data;
    expect(state.balanceCents).toBe(347_25);
    expect(state.changeTodayCents).toBe(347_25);
  });
});
