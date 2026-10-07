import type { CreditProvenance } from "./data/types";

/**
 * What the app may call a credit line's report, from the forwarder that
 * delivered it (Polaris for Business works it out: apps/business
 * src/server/cre/provenance.ts). Only a report Chainlink's DON signed,
 * delivered through Chainlink's KeystoneForwarder, is "Verified by Chainlink
 * CRE". A simulated run (the CRE CLI's simulator, through Chainlink's public
 * MockKeystoneForwarder, no DON signature) and a local one are named for what
 * they are. An API that doesn't say is never read as verified.
 */
export function provenanceOf(v: Pick<CreditProvenance, "delivery">): { label: string; verified: boolean } {
  switch (v.delivery) {
    case "don":
      return { label: "Verified by Chainlink CRE", verified: true };
    case "simulation":
      return { label: "Chainlink CRE (simulated)", verified: false };
    case "local":
      return { label: "CRE workflow, local run", verified: false };
    default:
      return { label: "CRE workflow report", verified: false };
  }
}
