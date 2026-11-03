import { Vim, type CodeMirror } from "@replit/codemirror-vim";
import { NavigationTracker, type NavigationOptions } from "./tracker";
export type { NavigationOptions } from "./tracker";

const sessions = new WeakMap<object, NavigationSession>();
let installed = false;

export function installNavigationCommands(): void {
  if (installed) return;
  installed = true;
  Vim.defineAction("lindvimeraSetMark", (cm, args) =>
    sessions.get(cm)?.setMark(args.selectedCharacter ?? ""),
  );
  Vim.defineAction("lindvimeraGoToMark", (cm, args) =>
    sessions.get(cm)?.goToMark(args.selectedCharacter ?? "", !!args.linewise),
  );
  Vim.defineAction("lindvimeraJumpBack", (cm, args) =>
    sessions.get(cm)?.walk(-1, args.repeat ?? 1),
  );
  Vim.defineAction("lindvimeraJumpForward", (cm, args) =>
    sessions.get(cm)?.walk(1, args.repeat ?? 1),
  );
  for (const [keys, action, args] of [
    ["m<register>", "lindvimeraSetMark", {}],
    ["'<register>", "lindvimeraGoToMark", { linewise: true }],
    ["`<register>", "lindvimeraGoToMark", { linewise: false }],
    ["<C-o>", "lindvimeraJumpBack", {}],
    ["<C-i>", "lindvimeraJumpForward", {}],
  ] as const) {
    Vim.mapCommand(keys, "action", action, args, {
      context: "normal",
      when: (cm: object) => sessions.has(cm),
    });
  }
}

export class NavigationSession extends NavigationTracker {
  constructor(cm: CodeMirror, options: NavigationOptions) {
    super(cm, options);
    sessions.set(cm, this);
    installNavigationCommands();
  }
  override destroy(): void {
    super.destroy();
    sessions.delete(this.cm);
  }
}
