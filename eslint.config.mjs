import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "codemirror-vim/**",
      ".generated/**",
      ".cache/**",
      ".test-runtime/**",
      "node_modules/**",
      "dist/**",
      ".release/**",
      ".release-gate/**",
      "test/**",
      "scripts/**",
      "patches/**",
      "docs/**",
      "*.config.ts",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          enforceCamelCaseLower: true,
          brands: ["Lindvimera", "Vim", "Live Preview", "Markdown", "Surround"],
        },
      ],
    },
  },
  {
    files: ["manifest.json"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { extraFileExtensions: [".json"] },
    },
    rules: {
      "obsidianmd/validate-manifest": "warn",
      "obsidianmd/validate-license": "warn",
    },
  },
]);
