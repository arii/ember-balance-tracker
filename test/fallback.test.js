import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMockMetaServer } from "../demo/mock-meta.mjs";
import { deriveRegexWithEmber, findBalanceWithEmber } from "../src/ember/client.js";
import { learnPattern, readWithFallback } from "../src/lib/fallback.js";
import { summarizeTrace } from "../src/lib/trace.js";

const enabled = (apiBase, allowPageText = true) => ({ emberEnabled: true, apiKey: "local-test-only", apiBase, allowPageText });

test("consent off makes no fallback call", async () => {
  let calls = 0;
  const result = await readWithFallback({
    text: "not a balance", pageText: "Balance $100.05", settings: enabled("http://127.0.0.1:1/v1", false), label: "balance",
    call: async () => { calls++; throw new Error("must not call"); },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
});

test("consent on derives once and later reads use the learned regex without calls", async (t) => {
  const mock = createMockMetaServer({ deriveSequence: ["valid"] });
  const apiBase = await mock.listen();
  t.after(() => mock.close());
  const learned = await learnPattern({ settings: enabled(apiBase), label: "balance", trainingText: "$100.05" });
  assert.equal(learned.ok, true);
  assert.equal(mock.calls.length, 1);
  const read = await readWithFallback({ text: "$250.25", pageText: "ignored", pattern: learned.pattern, settings: enabled(apiBase), label: "balance" });
  assert.equal(read.source, "pattern");
  assert.equal(read.parsed.value, 250.25);
  assert.equal(mock.calls.length, 1);
});

test("invalid, dangerous, and non-answer derive responses are rejected honestly", async (t) => {
  const mock = createMockMetaServer({ deriveSequence: ["invalid", "dangerous", "none"] });
  const apiBase = await mock.listen();
  t.after(() => mock.close());
  for (const mode of ["invalid", "dangerous", "none"]) {
    const learned = await learnPattern({ settings: enabled(apiBase), label: mode, trainingText: "$100.05" });
    assert.equal(learned.ok, false, mode);
  }
  const read = await readWithFallback({ text: "cannot find balance", pageText: "", pattern: null, settings: enabled(apiBase, false), label: "balance" });
  assert.deepEqual(read, { ok: false, reason: "unparseable" });
  assert.deepEqual(mock.calls.map((c) => c.mode), ["invalid", "dangerous", "none"]);
});

test("every mock call yields complete proof-of-usage trace and cumulative budget summary", async (t) => {
  const mock = createMockMetaServer({ deriveSequence: ["valid"] });
  const apiBase = await mock.listen();
  t.after(() => mock.close());
  const derive = await deriveRegexWithEmber({ apiBase, apiKey: "local-test-only", label: "balance", sampleText: "$100.05" });
  const find = await findBalanceWithEmber({ apiBase, apiKey: "local-test-only", label: "balance", pageText: "Available balance $100.05" });
  const trace = [derive.trace, find.trace];
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(trace.map((e) => [e.model, e.promptTokens, e.completionTokens, e.costUsd]), [
    ["muse-ember-1.0", 120, 12, 0.000018],
    ["muse-ember-1.0", 80, 4, 0.00001],
  ]);
  assert.deepEqual(summarizeTrace(trace), {
    calls: 2, failedCalls: 0, promptTokens: 200, completionTokens: 16, totalTokens: 216,
    costUsd: 0.000028, usageIncomplete: false, withinBudget: true,
  });
  const exported = JSON.parse(JSON.stringify(trace));
  assert.equal(exported.length, mock.calls.length);
  for (const entry of exported) {
    assert.ok(entry.ts);
    assert.equal(entry.model, "muse-ember-1.0");
    assert.equal(typeof entry.promptTokens, "number");
    assert.equal(typeof entry.completionTokens, "number");
    assert.equal(typeof entry.totalTokens, "number");
    assert.equal(typeof entry.costUsd, "number");
  }
});

test("production readTracker delegates to the tested helper", async () => {
  const src = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
  assert.match(src, /import \{ learnPattern, readWithFallback \} from "\.\/lib\/fallback\.js"/);
  const body = src.slice(src.indexOf("async function readTracker"));
  assert.match(body, /readWithFallback\(\{/);
  assert.equal((body.match(/allowPageText/g) || []).length, 0, "consent gate must live in the helper, not duplicated");
});

test("lazy getPageText is only called after the consent gate passes", async () => {
  let fetched = 0, calls = 0;
  const denied = await readWithFallback({
    text: "no numbers", pattern: null, settings: { emberEnabled: true, apiKey: "k", allowPageText: false },
    label: "x", getPageText: async () => { fetched++; return "Balance $100.05"; },
    call: async () => { calls++; return { ok: true, text: "Balance $100.05", trace: {} }; },
  });
  assert.equal(denied.ok, false); assert.equal(fetched, 0); assert.equal(calls, 0);
  const allowed = await readWithFallback({
    text: "no numbers", pattern: null, settings: { emberEnabled: true, apiKey: "k", allowPageText: true, apiBase: "mock" },
    label: "x", getPageText: async () => { fetched++; return "Balance $100.05"; },
    call: async () => { calls++; return { ok: true, text: "Balance $100.05", trace: {} }; },
  });
  assert.equal(allowed.ok, true); assert.equal(allowed.source, "ember"); assert.equal(fetched, 1); assert.equal(calls, 1);
});

test("HTTP errors are traced with status and never leak the API key", async (t) => {
  const mock = createMockMetaServer({ deriveSequence: ["error"], find: { status: 401 } });
  const apiBase = await mock.listen();
  t.after(() => mock.close());
  const key = "local-test-only";
  const derive = await deriveRegexWithEmber({ apiBase, apiKey: key, label: "balance", sampleText: "$100.05" });
  const find = await findBalanceWithEmber({ apiBase, apiKey: key, label: "balance", pageText: "no numbers" });
  assert.equal(derive.ok, false); assert.equal(derive.trace.ok, false); assert.equal(derive.trace.status, 500);
  assert.equal(find.ok, false); assert.equal(find.trace.ok, false); assert.equal(find.trace.status, 401);
  for (const e of [derive.trace, find.trace]) {
    assert.equal(e.model, "muse-ember-1.0");
    assert.equal(e.costUsd, null);
    assert.ok(!JSON.stringify(e).includes(key), "trace must not contain the API key");
  }
  const s = summarizeTrace([derive.trace, find.trace]);
  assert.equal(s.failedCalls, 2);
  assert.equal(s.usageIncomplete, true);
  assert.equal(s.costUsd, null);
});

test("successful call with missing usage is traced as unknown, not zero-cost", async (t) => {
  const mock = createMockMetaServer({ deriveSequence: ["no-usage"] });
  const apiBase = await mock.listen();
  t.after(() => mock.close());
  const derive = await deriveRegexWithEmber({ apiBase, apiKey: "local-test-only", label: "balance", sampleText: "$100.05" });
  assert.equal(derive.ok, true);
  assert.equal(derive.trace.ok, true);
  assert.equal(derive.trace.usageKnown, false);
  assert.equal(derive.trace.costUsd, null);
  assert.equal(derive.trace.promptTokens, null);
});
