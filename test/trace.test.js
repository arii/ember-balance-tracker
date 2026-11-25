import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTraceEntry, summarizeTrace, estimateCost } from "../src/lib/trace.js";

test("cost math matches Ember pricing ($0.10/M in, $0.50/M out)", () => {
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  near(estimateCost({ promptTokens: 100_000, completionTokens: 0 }), 0.01);
  near(estimateCost({ promptTokens: 0, completionTokens: 1_000_000 }), 0.50);
  // Over 200K input tokens the WHOLE request bills at long-context rates.
  near(estimateCost({ promptTokens: 1_000_000, completionTokens: 0 }), 0.30);
  near(estimateCost({ promptTokens: 300_000, completionTokens: 1_000_000 }), 0.09 + 1.50);
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
    calls: 2, failedCalls: 0, pendingReservations: 0, promptTokens: 10000, completionTokens: 40,
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

test("budgetAllows blocks at the cap and on unknown cost", async () => {
  const { budgetAllows } = await import("../src/lib/trace.js");
  const cheap = [makeTraceEntry({ usage: { prompt_tokens: 1000, completion_tokens: 10 } })];
  assert.deepEqual(budgetAllows(cheap, 2), { allowed: true, spentUsd: 0.000105, capUsd: 2 });
  const pricey = [makeTraceEntry({ usage: { prompt_tokens: 15_000_000, completion_tokens: 1_000_000 } })];
  const blocked = budgetAllows(pricey, 2);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "budget-exceeded");
  const unknown = [makeTraceEntry({ ok: false, status: 500, error: "http-500" })];
  const blockedUnknown = budgetAllows(unknown, 2);
  assert.equal(blockedUnknown.allowed, false);
  assert.equal(blockedUnknown.reason, "budget-cost-unknown", "unbounded cost cannot be verified against the cap");
});

test("pending reservations charge worst case without flagging usage unknown", async () => {
  const { budgetAllows, worstCaseCost } = await import("../src/lib/trace.js");
  const reservation = {
    ts: new Date().toISOString(), reservationId: "r1", pending: true,
    reservedUsd: worstCaseCost({ maxTokens: 60 }),
    model: "muse-ember-1.0", ok: false, status: null, error: "reservation-pending",
    usageKnown: false, promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null,
  };
  const s = summarizeTrace([reservation]);
  assert.equal(s.pendingReservations, 1);
  assert.equal(s.calls, 0);
  assert.equal(s.usageIncomplete, false, "a reservation is bounded, not unknown");
  assert.ok(s.costUsd > 0, "reservation spends its worst case immediately");
  // A reservation can only spend its worst case: never blocks on its own.
  assert.equal(budgetAllows([reservation], 2).allowed, true);
  // But it counts toward the cap like real spend.
  assert.equal(budgetAllows([reservation], s.costUsd).allowed, false, "reservation counts toward the cap at its charged worst case");
});

test("worstCaseCost is the official provable bound: context window + output cap at long-context rates", async () => {
  const { worstCaseCost, MUSE_EMBER_CONTEXT_TOKENS, EMBER_PRICE_PER_MTOK_LONG } = await import("../src/lib/trace.js");
  const derive = worstCaseCost({ maxTokens: 2000 });
  const find = worstCaseCost({ maxTokens: 1000 });
  // Input dominates: the context window at the long-context rate, no byte assumptions.
  assert.equal(worstCaseCost({ maxTokens: 0 }), (MUSE_EMBER_CONTEXT_TOKENS / 1e6) * EMBER_PRICE_PER_MTOK_LONG.input);
  assert.equal(find, (MUSE_EMBER_CONTEXT_TOKENS / 1e6) * EMBER_PRICE_PER_MTOK_LONG.input + (1000 / 1e6) * EMBER_PRICE_PER_MTOK_LONG.output);
  assert.ok(derive > find);
  assert.ok(derive < 0.32 && find < 0.32, `derive=${derive} find=${find}`);
});

test("budget compare uses the unrounded spend sum", async () => {
  const { budgetAllows } = await import("../src/lib/trace.js");
  // True total 2.0000008 exceeds a 2.0000005 cap; rounding to microdollars
  // (2.0) before comparing would UNDERSTATE spend and allow the call.
  const entries = [1.0000004, 1.0000004].map((c) => ({
    ok: true, usageKnown: true, costUsd: c,
    promptTokens: 1, completionTokens: 1, totalTokens: 2,
  }));
  const check = budgetAllows(entries, 2.0000005);
  assert.equal(check.allowed, false);
  assert.equal(check.reason, "budget-exceeded");
});

test("budgetAllows fails closed on an untrustworthy cap", async () => {
  const { budgetAllows } = await import("../src/lib/trace.js");
  for (const bad of [NaN, 0, -5, "2", undefined, null, Infinity]) {
    const r = budgetAllows([], bad);
    assert.equal(r.allowed, false, `cap ${String(bad)} must block`);
    assert.equal(r.reason, "budget-cap-invalid");
  }
});

test("malformed and legacy trace entries are never counted as free", () => {
  const negative = makeTraceEntry({ usage: { prompt_tokens: -5, completion_tokens: 10 } });
  assert.equal(negative.usageKnown, false, "negative token counts are unknown, not valid");
  const nanEntry = makeTraceEntry({ usage: { prompt_tokens: NaN, completion_tokens: 10 } });
  assert.equal(nanEntry.usageKnown, false);
  // Legacy entry from before usageKnown existed: has numbers, no flag.
  const legacy = { ts: new Date().toISOString(), model: "muse-ember-1.0", ok: true, promptTokens: 100, completionTokens: 10, costUsd: 0.000015 };
  const s = summarizeTrace([legacy]);
  assert.equal(s.usageIncomplete, true, "legacy entries without usageKnown are not assumed honest");
  assert.equal(s.costUsd, null);
  // Negative stored cost is rejected too.
  const bad = { ts: new Date().toISOString(), ok: true, usageKnown: true, promptTokens: 1, completionTokens: 1, costUsd: -1 };
  assert.equal(summarizeTrace([bad]).usageIncomplete, true);
});
