import { describe, expect, it } from "vitest";
import { planFolds, type FoldRange, type FoldRequest } from "../../src/folding/ranges";

const parent: FoldRange = { from: 3, to: 90, firstLine: 1, lastLine: 9 };
const child: FoldRange = { from: 23, to: 50, firstLine: 3, lastLine: 5 };
const sibling: FoldRange = { from: 63, to: 80, firstLine: 7, lastLine: 8 };
const other: FoldRange = { from: 103, to: 130, firstLine: 11, lastLine: 13 };
const folds = [parent, child, sibling, other];
const plan = (
  command: FoldRequest["command"],
  closed: FoldRange[] = [],
  extra: Partial<FoldRequest> = {},
) => planFolds(folds, closed, { command, line: 4, count: 1, ...extra });

describe("host fold range planning", () => {
  it("closes inner to outer and opens outer to inner using count", () => {
    expect(plan("zc").close).toEqual([child]);
    expect(plan("zc", [], { count: 2 }).close).toEqual([parent, child]);
    expect(plan("zo", [parent, child])).toEqual({ open: [parent], close: [] });
    expect(plan("zo", [parent, child], { count: 2 }).open).toEqual([parent, child]);
    expect(plan("zc", [parent, child]).close).toEqual([]);
  });

  it("chooses toggle direction once rather than alternating with count", () => {
    expect(plan("za", [], { count: 2 }).close).toEqual([parent, child]);
    expect(plan("za", [parent, child], { count: 2 }).open).toEqual([parent, child]);
  });

  it("opens descendants recursively and closes only the containing ancestor chain", () => {
    expect(plan("zO", [parent, child, sibling, other]).open).toEqual([parent, child, sibling]);
    expect(plan("zC", [], { count: 30 }).close).toEqual([parent, child]);
    expect(plan("zA", [parent, sibling]).open).toEqual([parent, sibling]);
    expect(plan("zA").close).toEqual([parent, child]);
  });

  it("includes descendants in global close and all existing folds in global open", () => {
    expect(plan("zM", [child], { line: 15 }).close).toEqual([parent, sibling, other]);
    expect(plan("zR", [child, other], { count: 9 }).open).toEqual([child, other]);
  });

  it("opens only one visible layer in a Visual range and ignores its count", () => {
    const selection = { firstLine: 1, lastLine: 13 };
    expect(plan("zo", folds, { selection, count: 20 }).open).toEqual([parent, other]);
    expect(plan("zc", [], { selection, count: 20 }).close).toEqual([parent, other]);
  });

  it("handles partial selections, siblings and recursive Visual operations", () => {
    const selection = { firstLine: 4, lastLine: 8 };
    expect(plan("zc", [], { selection }).close).toEqual([parent, child]);
    expect(plan("zC", [], { selection }).close).toEqual([parent, child, sibling]);
    expect(plan("zO", [parent, child, sibling, other], { selection }).open).toEqual([
      parent,
      child,
      sibling,
    ]);
  });

  it("treats a selected folded header as its complete source extent", () => {
    const selection = { firstLine: 1, lastLine: 1 };
    expect(plan("zO", [parent, child, sibling], { selection }).open).toEqual([
      parent,
      child,
      sibling,
    ]);
  });

  it("leaves plain text and unrelated folds alone", () => {
    expect(plan("zc", [], { line: 10 })).toEqual({ open: [], close: [] });
    expect(plan("zo", [other])).toEqual({ open: [], close: [] });
  });
});
