import type { Metadata } from "next";

import { ChainlinkView } from "./chainlink-view";

export const metadata: Metadata = { title: "Chainlink" };

export default function ChainlinkPage() {
  return <ChainlinkView />;
}
