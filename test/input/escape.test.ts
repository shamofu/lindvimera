import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EscapeInputSession, validateEscapeSettings } from "../../src/input/escape";

function setup(sequences = ["jj"], timeoutMs = 200) {
  const text = vi.fn();
  const exit = vi.fn();
  const session = new EscapeInputSession({ sequences, timeoutMs }, { onText: text, onExit: exit });
  return { session, text, exit };
}

describe("escape input before recording", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("consumes jj without putting either key into the input/recording path", () => {
    const { session, text, exit } = setup();
    expect(session.handleKey({ key: "a" })).toBe(false);
    expect(session.handleKey({ key: "j" })).toBe(true);
    vi.advanceTimersByTime(199);
    expect(session.handleKey({ key: "j" })).toBe(true);
    expect(text).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(text).not.toHaveBeenCalled();
  });

  it("flushes a timed-out key exactly once", () => {
    const { session, text, exit } = setup();
    session.handleKey({ key: "j" });
    vi.advanceTimersByTime(200);
    session.flush();
    expect(text.mock.calls).toEqual([["j"]]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not match a stale candidate even when the timer task was delayed", () => {
    const { session, text, exit } = setup();
    session.handleKey({ key: "j" });
    vi.setSystemTime(Date.now() + 201);
    session.handleKey({ key: "j" });
    expect(text.mock.calls).toEqual([["j"]]);
    expect(exit).not.toHaveBeenCalled();
    session.dispose();
    expect(text.mock.calls).toEqual([["j"], ["j"]]);
  });

  it("preserves mismatched characters in their original order", () => {
    const { session, text, exit } = setup();
    session.handleKey({ key: "j" });
    expect(session.handleKey({ key: "a" })).toBe(true);
    expect(text.mock.calls).toEqual([["ja"]]);
    vi.runAllTimers();
    expect(exit).not.toHaveBeenCalled();
  });

  it("supports shared prefixes and sequences longer than two keys", () => {
    const { session, text, exit } = setup(["jkj", "jkk"]);
    for (const key of "jkk") session.handleKey({ key });
    expect(text).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("retains an overlapping suffix after a mismatch", () => {
    const { session, text, exit } = setup(["jkj"]);
    for (const key of "jjkj") session.handleKey({ key });
    expect(text.mock.calls).toEqual([["j"]]);
    expect(exit).toHaveBeenCalledOnce();
  });

  it("recognizes a complete escape contained in the mismatch suffix", () => {
    const { session, text, exit } = setup(["abjk", "jj"]);
    for (const key of "abjj") session.handleKey({ key });
    expect(text.mock.calls).toEqual([["ab"]]);
    expect(exit).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(text.mock.calls).toEqual([["ab"]]);
  });

  it.each([
    { key: "j", repeat: true },
    { key: "j", composing: true },
    { key: "j", origin: "macro" as const },
    { key: "j", origin: "repeat" as const },
    { key: "jj", origin: "paste" as const },
    { key: "j", origin: "programmatic" as const },
    { key: "<Left>" },
  ])("flushes before excluded input %j and never interprets it as escape", (input) => {
    const { session, text, exit } = setup();
    session.handleKey({ key: "j" });
    expect(session.handleKey(input)).toBe(false);
    expect(text.mock.calls).toEqual([["j"]]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("flushes into the original target on reconfigure and disposal", () => {
    const left = setup();
    const right = setup();
    left.session.handleKey({ key: "j" });
    right.session.handleKey({ key: "j" });
    left.session.configure({ sequences: ["jk"], timeoutMs: 100 });
    right.session.dispose();
    right.session.dispose();
    vi.runAllTimers();
    expect(left.text.mock.calls).toEqual([["j"]]);
    expect(right.text.mock.calls).toEqual([["j"]]);
    expect(right.session.handleKey({ key: "j" })).toBe(false);
  });

  it("allows disabling escape sequences", () => {
    const { session, exit } = setup([]);
    expect(session.handleKey({ key: "j" })).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it("rejects duplicates, true prefixes, unsupported keys and invalid timeouts", () => {
    for (const sequences of [["jj", "jjj"], ["jj", "jj"], ["j"], ["日本"], ["j\n"]]) {
      expect(validateEscapeSettings({ sequences, timeoutMs: 200 }).length).toBeGreaterThan(0);
    }
    expect(validateEscapeSettings({ sequences: ["jk", "jj"], timeoutMs: 200 })).toEqual([]);
    expect(() => setup(["jj"], Number.NaN)).toThrow();
    expect(() => setup(["jj"], 0)).toThrow();
  });
});
