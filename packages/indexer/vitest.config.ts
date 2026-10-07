import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // client/ has its own tests (node:test), run from the workspace.
    include: ["test/**/*.test.ts"],
    // The simulated source reports the last simulated block as the chain head;
    // the production block lag (2) would wait forever for two more blocks.
    env: { ENVIO_BLOCK_LAG: "0" },
    testTimeout: 60_000,
    // One Envio test indexer at a time: they share process-wide registration state.
    fileParallelism: false,
  },
});
