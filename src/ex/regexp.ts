import { Vim } from "@replit/codemirror-vim";

/** Use the embedded search dialect without touching its search register or history. */
export function exPattern(pattern: string, pcre = true): string {
  return pcre ? pattern : Vim.translateRegex(pattern);
}
