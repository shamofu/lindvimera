import { describe, expect, it, vi } from "vitest";
import { NativeAdapterLifetime } from "../src/engines/builtin/adapter-lifetime";
import type { NativeCM, NativeVim } from "../src/engines/builtin/native";

describe("native adapter mode lifetime", () => {
  it("guards only tracked destroyed adapters and restores exact native hooks", () => {
    const enter = vi.fn();
    const exit = vi.fn();
    const vim = { enterInsertMode: enter, exitInsertMode: exit } as unknown as NativeVim;
    const cm = { state: { vim: {} } } as NativeCM;
    const foreign = { state: {} } as NativeCM;
    const lifetime = new NativeAdapterLifetime();
    lifetime.track(cm, vim);
    vim.enterInsertMode?.(cm);
    vim.exitInsertMode?.(cm, true);
    expect(enter).toHaveBeenCalledWith(cm, undefined);
    expect(exit).toHaveBeenCalledWith(cm, true);
    delete cm.state.vim;
    vim.enterInsertMode?.(cm);
    vim.exitInsertMode?.(cm);
    expect(enter).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    vim.exitInsertMode?.(foreign);
    expect(exit).toHaveBeenCalledTimes(2);
    lifetime.dispose();
    expect(vim.enterInsertMode).toBe(enter);
    expect(vim.exitInsertMode).toBe(exit);
  });

  it("preserves later foreign wrappers and releases its adapter tracking", () => {
    const original = vi.fn();
    const vim = { exitInsertMode: original } as unknown as NativeVim;
    const cm = { state: {} } as NativeCM;
    const lifetime = new NativeAdapterLifetime();
    lifetime.track(cm, vim);
    const owned = vim.exitInsertMode!;
    const foreign = vi.fn((target: NativeCM) => owned.call(vim, target));
    vim.exitInsertMode = foreign;
    lifetime.dispose();
    expect(vim.exitInsertMode).toBe(foreign);
    vim.exitInsertMode(cm);
    expect(original).toHaveBeenCalledOnce();
  });
});
