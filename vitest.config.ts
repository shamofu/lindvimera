import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
    alias: {
      "@replit/codemirror-vim": fileURLToPath(
        new URL(
          "./.generated/codemirror-vim/packages/codemirror-vim/src/index.ts",
          import.meta.url,
        ),
      ),
      "@replit/codemirror-vim-core": fileURLToPath(
        new URL("./.generated/codemirror-vim/packages/codemirror-vim-core/vim.js", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["./test/obsidian-dom.ts"],
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 15000,
  },
});
