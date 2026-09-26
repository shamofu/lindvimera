/** A host fold includes its visible header line and hides the half-open source range. */
export interface FoldRange {
  from: number;
  to: number;
  firstLine: number;
  lastLine: number;
}

export type FoldCommand = "za" | "zo" | "zc" | "zA" | "zO" | "zC" | "zM" | "zR";

export interface FoldRequest {
  command: FoldCommand;
  line: number;
  count: number;
  selection?: { firstLine: number; lastLine: number };
}

export function foldKey(range: Pick<FoldRange, "from" | "to">): string {
  return `${range.from}:${range.to}`;
}

/** Resolve effects without changing the editor while traversing nested folds. */
export function planFolds(
  candidates: readonly FoldRange[],
  folded: readonly FoldRange[],
  request: FoldRequest,
): { close: FoldRange[]; open: FoldRange[] } {
  const all = [
    ...new Map([...candidates, ...folded].map((fold) => [foldKey(fold), fold])).values(),
  ].sort((a, b) => a.from - b.from || b.to - a.to);
  const original = new Set(folded.map(foldKey));
  const closed = new Set(original);
  const containing = (line: number) =>
    all.filter((fold) => fold.firstLine <= line && line <= fold.lastLine);
  const firstClosed = (line: number) => containing(line).find((fold) => closed.has(foldKey(fold)));
  const open = (line: number, recursive: boolean): FoldRange | undefined => {
    const fold = firstClosed(line);
    if (!fold) return;
    for (const child of all)
      if (child === fold || (recursive && child.from >= fold.from && child.to <= fold.to))
        closed.delete(foldKey(child));
    return fold;
  };
  const close = (line: number, recursive: boolean): FoldRange | undefined => {
    let last: FoldRange | undefined;
    for (const fold of containing(line)) {
      if (!recursive && closed.has(foldKey(fold))) break;
      if (recursive) closed.add(foldKey(fold));
      last = fold;
    }
    if (last) closed.add(foldKey(last));
    return last;
  };
  if (request.command === "zR") closed.clear();
  else if (request.command === "zM") for (const fold of all) closed.add(foldKey(fold));
  else {
    const recursive =
      request.command === "zA" || request.command === "zO" || request.command === "zC";
    const opening =
      request.command === "zo" ||
      request.command === "zO" ||
      ((request.command === "za" || request.command === "zA") && !!firstClosed(request.line));
    const operate = opening ? open : close;
    if (request.selection) {
      let { firstLine, lastLine } = request.selection;
      // A selected folded display line represents the complete hidden source range.
      for (const fold of all.filter((fold) => original.has(foldKey(fold)))) {
        if (fold.firstLine <= firstLine && firstLine <= fold.lastLine) firstLine = fold.firstLine;
        if (fold.firstLine <= lastLine && lastLine <= fold.lastLine) lastLine = fold.lastLine;
      }
      if (recursive && !opening) {
        for (const fold of all)
          if (fold.firstLine <= lastLine && firstLine <= fold.lastLine) closed.add(foldKey(fold));
      } else {
        for (let line = firstLine; line <= lastLine;) {
          const hidden = firstClosed(line);
          const fold = operate(line, recursive);
          if (fold || hidden) line = Math.max(line + 1, (fold ?? hidden)!.lastLine + 1);
          else {
            // Plain source lines can far outnumber fold headers in a long note.
            const next = all.find(
              (candidate) =>
                candidate.firstLine > line && (!opening || closed.has(foldKey(candidate))),
            );
            if (!next) break;
            line = next.firstLine;
          }
        }
      }
    } else {
      const count = recursive ? 1 : Math.max(1, Math.min(all.length, Math.floor(request.count)));
      for (let index = 0; index < count; index++) {
        if (!operate(request.line, recursive)) break;
      }
    }
  }
  return {
    close: all.filter((fold) => closed.has(foldKey(fold)) && !original.has(foldKey(fold))),
    open: all.filter((fold) => !closed.has(foldKey(fold)) && original.has(foldKey(fold))),
  };
}
