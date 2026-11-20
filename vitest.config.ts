import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { vimAliases } from "./scripts/engines/build.mjs";

export default defineConfig({
  plugins: [
    {
      name: "obsidian-test-runtime",
      resolveId(id) {
        // Obsidian's package contains types only; tests supply its runtime with vi.mock.
        if (id === "obsidian") return id;
      },
    },
  ],
  resolve: {
    alias: vimAliases(fileURLToPath(new URL(".", import.meta.url))),
  },
  test: {
    include: ["test/**/*.test.ts"],
    pool: "vmThreads",
    environment: "jsdom",
    setupFiles: ["./test/obsidian-dom.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 15000,
  },
});
