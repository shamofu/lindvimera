import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateAuditResult } from "../scripts/audit-dependencies.mjs";

function result(counts = {}, status = 0) {
  return {
    status,
    signal: null,
    stdout: JSON.stringify({
      advisories: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts },
      },
    }),
  };
}

test("accepts a complete clean audit", () => {
  assert.equal(evaluateAuditResult(result()).exitCode, 0);
});

test("allows low and moderate findings even when pnpm exits with 1", () => {
  const outcome = evaluateAuditResult(result({ info: 1, low: 2, moderate: 3 }, 1));
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.counts, { info: 1, low: 2, moderate: 3, high: 0, critical: 0 });
  assert.equal(outcome.report.metadata.vulnerabilities.moderate, 3);
});

for (const severity of ["high", "critical"]) {
  for (const status of [0, 1]) {
    test(`blocks ${severity} findings independently of pnpm status ${status}`, () => {
      assert.equal(evaluateAuditResult(result({ [severity]: 1 }, status)).exitCode, 1);
    });
  }
}

test("rejects an execution failure even if stdout resembles a clean audit", () => {
  assert.throws(
    () => evaluateAuditResult({ ...result(), error: new Error("spawn failed") }),
    /Could not run/,
  );
});

test("rejects a signal or unexpected process status", () => {
  for (const abnormal of [{ status: null }, { status: 2 }, { signal: "SIGTERM" }]) {
    assert.throws(
      () => evaluateAuditResult({ ...result(), ...abnormal }),
      /did not complete successfully/,
    );
  }
});

test("rejects pnpm failure without advisory findings", () => {
  assert.throws(() => evaluateAuditResult(result({}, 1)), /failed without reporting/);
});

test("rejects registry errors and missing audit metadata", () => {
  for (const report of [
    null,
    {},
    { error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" } },
    { ...JSON.parse(result().stdout), error: "registry unavailable" },
    { metadata: { vulnerabilities: [] } },
  ]) {
    assert.throws(
      () => evaluateAuditResult({ ...result(), stdout: JSON.stringify(report) }),
      /did not return vulnerability counts/,
    );
  }
});

test("rejects empty, malformed, or truncated JSON", () => {
  for (const stdout of ["", "registry unavailable", '{"metadata":']) {
    assert.throws(
      () => evaluateAuditResult({ ...result(), stdout }),
      /did not return a valid JSON report/,
    );
  }
});

for (const severity of ["info", "low", "moderate", "high", "critical"]) {
  test(`validates the ${severity} count before trusting the report`, () => {
    for (const count of [undefined, null, "0", -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => evaluateAuditResult(result({ [severity]: count })),
        new RegExp(`invalid ${severity} count`),
      );
    }
  });
}
