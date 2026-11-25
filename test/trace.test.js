import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTraceEntry, summarizeTrace, estimateCost } from "../src/lib/trace.js";

test("cost math matches Ember pricing ($0.10/M in, $0.50/M out)", () => {
  assert.equal(estimateCost({ promptTokens: 1_000_000, completionTokens: 0 }), 0.10);
  assert.equal(estimateCost({ promptTokens: 0, completionTokens: 1_000_000 }), 0.50);
});

test("trace entry carries usage and cost", () => {
  const e = makeTraceEntry({ label: "Runware", usage: { prompt_tokens: 2000, completion_tokens: 10, total_tokens: 2010 } });
  assert.equal(e.promptTokens, 2000);
  assert.equal(e.completionTokens, 10);
  assert.equal(e.totalTokens, 2010);
  assert.ok(e.costUsd > 0 && e.costUsd < 0.001, `fraction of a cent, got ${e.costUsd}`);
});

test("summary checks the $10 budget", () => {
  const entries = [
    makeTraceEntry({ usage: { prompt_tokens: 5000, completion_tokens: 20 } }),
    makeTraceEntry({ usage: { prompt_tokens: 5000, completion_tokens: 20 } }),
  ];
  const s = summarizeTrace(entries);
  assert.equal(s.calls, 2);
  assert.equal(s.withinBudget, true);
});
