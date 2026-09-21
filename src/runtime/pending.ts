import { Vim, type CodeMirror } from "@replit/codemirror-vim";
import type { CommandContinuation } from "@replit/codemirror-vim-core";
import type { VimHistoryGroup } from "./history";

/** One suspended command chain per editor. Inner continuations precede their callers. */
export class PendingCommands implements CommandContinuation {
  pending = false;
  private generation = 0;
  private queue: (() => void)[] = [];
  private inserting = -1;
  private cancelTask?: () => void;
  private releaseHistory?: () => void;
  private previous: CommandContinuation | undefined;

  constructor(
    private cm: CodeMirror,
    private history: VimHistoryGroup,
    private error: (message: string) => void,
  ) {
    this.previous = cm.state.commandContinuation;
    cm.state.commandContinuation = this;
  }

  defer(resume: () => void): boolean {
    if (!this.pending) return false;
    if (this.inserting < 0) this.queue.push(resume);
    else this.queue.splice(this.inserting++, 0, resume);
    return true;
  }

  waitFor(task: Promise<void>, cancel: () => void): void {
    if (this.pending) this.cancel();
    const generation = ++this.generation;
    this.pending = true;
    this.cancelTask = cancel;
    this.releaseHistory ??= this.history.hold();
    void task.then(
      () => {
        if (generation !== this.generation) return;
        this.pending = false;
        this.cancelTask = undefined;
        this.drain();
      },
      (reason: unknown) => {
        if (generation !== this.generation) return;
        this.cancel();
        this.error(reason instanceof Error ? reason.message : String(reason));
      },
    );
  }

  private drain(): void {
    try {
      while (!this.pending && this.queue.length) {
        const resume = this.queue.shift()!;
        this.inserting = 0;
        this.cm.operation(resume);
        this.inserting = -1;
        if (this.cm.state.commandPolicy?.rejected) {
          this.cancel();
          return;
        }
      }
      if (!this.pending) {
        this.releaseHistory?.();
        this.releaseHistory = undefined;
      }
    } catch (reason) {
      this.cancel();
      this.error(reason instanceof Error ? reason.message : String(reason));
    } finally {
      this.inserting = -1;
    }
  }

  cancel(): void {
    const active = this.pending || this.queue.length > 0 || this.inserting >= 0;
    this.generation++;
    this.pending = false;
    this.queue = [];
    const cancel = this.cancelTask;
    this.cancelTask = undefined;
    try {
      cancel?.();
    } finally {
      this.releaseHistory?.();
      this.releaseHistory = undefined;
      if (active) {
        if (this.cm.state.commandPolicy) this.cm.state.commandPolicy.rejected = true;
        if (this.cm.state.vim) Vim.cancelPendingInput(this.cm);
      }
    }
  }

  destroy(): void {
    this.cancel();
    if (this.cm.state.commandContinuation === this)
      this.cm.state.commandContinuation = this.previous;
  }
}
