export type InputOrigin = "user" | "paste" | "macro" | "repeat" | "programmatic";

export interface EscapeKeyInput {
  key: string;
  repeat?: boolean;
  composing?: boolean;
  origin?: InputOrigin;
}

export interface EscapeSettings {
  sequences: readonly string[];
  timeoutMs: number;
}

export const DEFAULT_ESCAPE_SETTINGS: EscapeSettings = {
  sequences: [],
  timeoutMs: 200,
};

/** Settings must be unambiguous: a completed escape never waits for another key. */
export function validateEscapeSettings(settings: EscapeSettings): string[] {
  const errors: string[] = [];
  if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0) {
    errors.push("Escape timeout must be a positive number of milliseconds.");
  }
  const seen = new Set<string>();
  for (const sequence of settings.sequences) {
    if (!/^[\x20-\x7e]{2,}$/.test(sequence)) {
      errors.push("Escape sequences must contain at least two printable ASCII keys.");
    }
    if (seen.has(sequence)) errors.push(`Duplicate escape sequence: ${sequence}`);
    seen.add(sequence);
  }
  const sequences = [...seen];
  for (let index = 0; index < sequences.length; index += 1) {
    for (let other = index + 1; other < sequences.length; other += 1) {
      const left = sequences[index];
      const right = sequences[other];
      if (left.startsWith(right) || right.startsWith(left)) {
        errors.push(`Escape sequences cannot be complete prefixes: ${left}, ${right}`);
      }
    }
  }
  return errors;
}

export function checkedEscapeSettings(settings: EscapeSettings): EscapeSettings {
  const errors = validateEscapeSettings(settings);
  if (errors.length) throw new Error(errors.join("\n"));
  return { sequences: [...settings.sequences], timeoutMs: settings.timeoutMs };
}

export function isEscapeKey(input: EscapeKeyInput): boolean {
  return (
    (!input.origin || input.origin === "user") && !input.repeat && /^[\x20-\x7e]$/.test(input.key)
  );
}

export interface EscapeCallbacks {
  /** Display candidates immediately, without adding them to the document or recorder. */
  onPreview?(text: string): void;
  /** Insert once through the normal editor input/recording path, bypassing this matcher. */
  onText(text: string): void;
  /** Record the semantic Escape, never the physical escape sequence. */
  onExit(): void;
}

/** One instance per input target. Candidates are visible before their recording is decided. */
export class EscapeInputSession {
  private settings: EscapeSettings;
  private pending = "";
  private timer: number | undefined;
  private expiresAt = 0;
  private disposed = false;

  constructor(
    settings: EscapeSettings,
    private readonly callbacks: EscapeCallbacks,
  ) {
    this.settings = checkedEscapeSettings(settings);
  }

  /** Returns true only when this session took responsibility for the physical key. */
  handleKey(input: EscapeKeyInput): boolean {
    if (this.disposed) return false;
    if (this.pending && Date.now() >= this.expiresAt) this.flush();
    if (input.composing || !isEscapeKey(input)) {
      this.flush();
      return false;
    }
    if (!this.pending && !this.settings.sequences.some((value) => value.startsWith(input.key))) {
      return false;
    }
    this.clearTimer();
    const candidate = this.pending + input.key;
    this.pending = "";
    this.callbacks.onPreview?.("");
    if (this.settings.sequences.includes(candidate)) {
      this.callbacks.onExit();
      return true;
    }

    // Retain the longest valid suffix; all preceding keys become ordinary input.
    let suffix = candidate;
    while (suffix && !this.settings.sequences.some((value) => value.startsWith(suffix))) {
      suffix = suffix.slice(1);
    }
    this.pending = suffix;
    const literal = candidate.slice(0, candidate.length - suffix.length);
    const complete = this.settings.sequences.includes(suffix);
    if (complete) this.pending = "";
    if (literal) this.callbacks.onText(literal);
    if (complete) this.callbacks.onExit();
    if (this.pending) {
      this.callbacks.onPreview?.(this.pending);
      this.expiresAt = Date.now() + this.settings.timeoutMs;
      this.timer = window.setTimeout(() => this.flush(), this.settings.timeoutMs);
    }
    return true;
  }

  /** Call before moving focus, entering composition, or changing the input target. */
  flush(): void {
    this.clearTimer();
    const text = this.pending;
    this.pending = "";
    if (text) {
      this.callbacks.onPreview?.("");
      this.callbacks.onText(text);
    }
  }

  configure(settings: EscapeSettings): void {
    const checked = checkedEscapeSettings(settings);
    this.flush();
    this.settings = checked;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flush();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.expiresAt = 0;
  }
}
