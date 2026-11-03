import { expect, it } from "vitest";
import { bindRuntime } from "./runtime";

it("rejects a missing or incompatible installed runtime before a suite runs", () => {
  for (const candidate of [undefined, null, {}, { version: 0 }, { version: 1 }])
    expect(() => bindRuntime(candidate)).toThrow(/requires version 2/);
});

it("rejects an incomplete runtime even when its version matches", () => {
  expect(() => bindRuntime({ version: 2, engine: { active: "embedded" } })).toThrow(
    /missing getCM/,
  );
});

it("refuses to count embedded suites as native engine coverage", () => {
  expect(() => bindRuntime({ version: 2, engine: { active: "builtin" }, backend: {} })).toThrow(
    /requires the embedded backend/,
  );
});
