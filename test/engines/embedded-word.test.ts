import { expect, it } from "vitest";
import { createWordProvider } from "../../src/word";
import { installWordProvider } from "../../src/engines/embedded/word";

it("installs per editor and restores the preceding provider on dispose", () => {
  const previous = createWordProvider();
  const cm = { state: { wordBoundaryProvider: previous } };
  const dispose = installWordProvider(cm);
  expect(cm.state.wordBoundaryProvider).not.toBe(previous);
  dispose();
  expect(cm.state.wordBoundaryProvider).toBe(previous);
});
