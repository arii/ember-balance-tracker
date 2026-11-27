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
