import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesTab, trackersForTab, readButtonLabel, autoReadSummary } from "../src/lib/autoread.js";

const a = { id: "a", urlPattern: "https://runware.ai/dashboard" };
const b = { id: "b", urlPattern: "https://other.example/billing" };

test("trackersForTab selects only trackers for the active tab URL", () => {
  assert.deepEqual(trackersForTab([a, b], "https://runware.ai/dashboard/usage").map((t) => t.id), ["a"]);
  assert.deepEqual(trackersForTab([a, b], "https://example.com/").map((t) => t.id), []);
});
test("matchesTab is false for missing url or pattern", () => {
  assert.equal(matchesTab(a, undefined), false);
  assert.equal(matchesTab({ id: "x" }, "https://runware.ai/"), false);
});
test("button says Refresh on the tracked page and Go to tab elsewhere", () => {
  assert.equal(readButtonLabel(a, "https://runware.ai/dashboard"), "Refresh");
  assert.equal(readButtonLabel(b, "https://runware.ai/dashboard"), "Go to tab");
});
test("autoReadSummary reports successes and failures", () => {
  assert.equal(autoReadSummary([]), "");
  assert.equal(autoReadSummary([{ ok: true }]), "Read 1 balance on this page.");
  assert.equal(autoReadSummary([{ ok: true }, { ok: true }]), "Read 2 balances on this page.");
  assert.equal(autoReadSummary([{ ok: true }, { ok: false }]), "Read 1 of 2 on this page; 1 need attention.");
});

import { localOnlySettings } from "../src/lib/autoread.js";
import { readWithFallback } from "../src/lib/fallback.js";

test("automatic reads never call the paid Ember fallback even when it is enabled and consented", async () => {
  const stored = { emberEnabled: true, apiKey: "local-test-only", apiBase: "http://127.0.0.1:1/v1", allowPageText: true };
  assert.equal(localOnlySettings(stored).emberEnabled, false);
  assert.equal(stored.emberEnabled, true, "stored settings are not mutated");
  let calls = 0;
  const call = async () => { calls++; throw new Error("must not call"); };
  const auto = await readWithFallback({ text: "not a balance", pageText: "Balance $100.05", settings: localOnlySettings(stored), label: "b", call });
  assert.equal(auto.ok, false);
  assert.equal(auto.reason, "unparseable");
  assert.equal(calls, 0);
});

test("automatic reads still succeed from the DOM text locally", async () => {
  const stored = { emberEnabled: true, apiKey: "k", allowPageText: true };
  const r = await readWithFallback({ text: "$100.05", settings: localOnlySettings(stored), label: "b", call: async () => { throw new Error("no"); } });
  assert.equal(r.ok, true);
  assert.equal(r.source, "dom");
});

test("background wires auto reads to local-only settings and the popup sends auto: true", async () => {
  const { readFile } = await import("node:fs/promises");
  const bg = await readFile(new URL("../src/background.js", import.meta.url), "utf8");
  const popup = await readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8");
  assert.ok(bg.includes("auto ? localOnlySettings(stored) : stored"));
  assert.ok(bg.includes("msg.auto === true"));
  assert.ok(popup.includes("ebt:read-tracker\", id: t.id, tabId: tab.id, auto: true"));
  assert.ok(!popup.includes("ebt:read-tracker\", id: t.id, tabId: tab.id })") || popup.includes("async function readTracker"), "manual path keeps its own call");
});
