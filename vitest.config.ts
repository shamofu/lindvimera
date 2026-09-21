import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
    restoreMocks: true,
    clearMocks: true,
    testTimeout: 15000,
  },
});
