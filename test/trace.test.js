import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTraceEntry, summarizeTrace, estimateCost } from "../src/lib/trace.js";

test("cost math matches Ember pricing ($0.10/M in, $0.50/M out)", () => {
  assert.equal(estimateCost({ promptTokens: 1_000_000, completionTokens: 0 }), 0.10);
  assert.equal(estimateCost({ promptTokens: 0, completionTokens: 1_000_000 }), 0.50);
});

test("traced model identity matches the production request model", () => {
  const e = makeTraceEntry({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.equal(e.model, "muse-ember-1.0", "trace must name the model actually requested, not an alias");
});

test("trace entry carries usage and cost", () => {
  const e = makeTraceEntry({ label: "Runware", usage: { prompt_tokens: 2000, completion_tokens: 10, total_tokens: 2010 } });
  assert.equal(e.promptTokens, 2000);
  assert.equal(e.completionTokens, 10);
  assert.equal(e.totalTokens, 2010);
  assert.equal(e.usageKnown, true);
  assert.ok(e.costUsd > 0 && e.costUsd < 0.001, `fraction of a cent, got ${e.costUsd}`);
});

test("unknown usage is null, never a fabricated zero cost", () => {
  const e = makeTraceEntry({ label: "x" }); // no usage from the API
  assert.equal(e.usageKnown, false);
  assert.equal(e.promptTokens, null);
  assert.equal(e.completionTokens, null);
  assert.equal(e.totalTokens, null);
  assert.equal(e.costUsd, null, "cost of an unknown-usage call is unknown, not $0");
  assert.equal(estimateCost({ promptTokens: null, completionTokens: null }), null);
});

test("failed calls are traced with status and reason, without secrets", () => {
  const e = makeTraceEntry({ label: "x", ok: false, status: 500, error: "http-500" });
  assert.equal(e.ok, false);
  assert.equal(e.status, 500);
  assert.equal(e.error, "http-500");
  assert.equal(e.costUsd, null);
  assert.ok(!JSON.stringify(e).match(/bearer|api[-_]?key|authorization/i), "no credential material in a trace entry");
});

test("summary checks the $10 budget when all usage is known", () => {
  const entries = [
    makeTraceEntry({ usage: { prompt_tokens: 5000, completion_tokens: 20 } }),
    makeTraceEntry({ usage: { prompt_tokens: 5000, completion_tokens: 20 } }),
  ];
  const s = summarizeTrace(entries);
  assert.deepEqual(s, {
    calls: 2, failedCalls: 0, promptTokens: 10000, completionTokens: 40,
    totalTokens: 10040, costUsd: 0.00102, usageIncomplete: false, withinBudget: true,
  });
});

test("summary refuses a cost total when any usage is unknown", () => {
  const entries = [
    makeTraceEntry({ usage: { prompt_tokens: 5000, completion_tokens: 20 } }),
    makeTraceEntry({ ok: false, status: 500, error: "http-500" }),
  ];
  const s = summarizeTrace(entries);
  assert.equal(s.calls, 2);
  assert.equal(s.failedCalls, 1);
  assert.equal(s.usageIncomplete, true);
  assert.equal(s.costUsd, null, "partial cost would understate spend");
  assert.equal(s.withinBudget, null, "budget verdict is unknown, not optimistically true");
});
