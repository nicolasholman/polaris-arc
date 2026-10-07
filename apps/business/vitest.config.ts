import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: fileURLToPath(new URL("./src/", import.meta.url)) },
      // `server-only` throws outside React Server Components; route tests import server modules directly.
      { find: /^server-only$/, replacement: fileURLToPath(new URL("./test/helpers/empty.ts", import.meta.url)) },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    // Route tests share module state (the store, the config); run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
