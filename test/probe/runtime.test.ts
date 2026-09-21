import { expect, it } from "vitest";
import { bindRuntime } from "./runtime";

it("rejects a missing or incompatible installed runtime before a suite runs", () => {
  for (const candidate of [undefined, null, {}, { version: 0 }, { version: 2 }])
    expect(() => bindRuntime(candidate)).toThrow(/requires version 1/);
});

it("rejects an incomplete runtime even when its version matches", () => {
  expect(() => bindRuntime({ version: 1 })).toThrow(/missing getCM/);
});
