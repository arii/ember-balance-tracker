import { test } from "node:test";
import assert from "node:assert/strict";
import { dueForTab, badgeFor, DUE_AFTER_MS } from "../src/lib/autoread.js";
import { planRefreshAll, summarizeRefreshAll, originPattern, isMetaHost } from "../src/lib/autoread.js";
import { formatMeta } from "../src/lib/format.js";

const NOW = Date.parse("2026-11-28T12:00:00Z");
const mk = (over) => ({ id: "a", urlPattern: "https://x.test/", history: [{ ts: new Date(NOW - 60_000).toISOString(), value: 5 }], ...over });

test("fresh reading is not due, no badge", () => {
  assert.deepEqual(dueForTab([mk()], "https://x.test/p", NOW), []);
  assert.equal(badgeFor([mk()], "https://x.test/p", NOW).text, "");
});
test("old, never-read and failed readings are due", () => {
  const old = mk({ history: [{ ts: new Date(NOW - DUE_AFTER_MS - 1000).toISOString(), value: 5 }] });
  const never = mk({ history: [] });
  const failed = mk({ lastFailure: { ts: new Date(NOW - 1000).toISOString(), reason: "x" } });
  for (const t of [old, never, failed]) assert.equal(dueForTab([t], "https://x.test/p", NOW).length, 1);
  assert.match(badgeFor([old, never], "https://x.test/p", NOW).title, /2 balances/);
});
test("other tabs are never labelled", () => {
  assert.equal(badgeFor([mk({ history: [] })], "https://other.test/", NOW).text, "");
});
test("an old cached value is not presented as fresh", () => {
  const old = mk({ history: [{ ts: new Date(NOW - 3_600_000).toISOString(), value: 5 }], anchor: "a" });
  assert.match(formatMeta(old, NOW), /1 h ago - may be out of date/);
  assert.doesNotMatch(formatMeta(mk({ anchor: "a" }), NOW), /out of date/);
});
test("a failed latest check says so and keeps the last good time", () => {
  const t = mk({ anchor: "a", lastFailure: { ts: new Date(NOW).toISOString(), reason: "r" } });
  assert.match(formatMeta(t, NOW), /last good read 1 min ago, latest check failed/);
});

test("refresh all never reports an unreachable balance as refreshed", () => {
  const ts = [{ id: "a", label: "A", urlPattern: "https://a.test/" }, { id: "b", label: "B", urlPattern: "https://b.test/" }, { id: "c", label: "C", urlPattern: "https://c.test/" }, { id: "d", label: "D", urlPattern: "https://d.test/" }];
  const plan = planRefreshAll(ts, "https://a.test/x", [{ id: 1, url: "https://a.test/x" }, { id: 2, url: "https://b.test/y" }]);
  assert.deepEqual(plan.map((p) => p.action), ["read", "allow", "open", "open"]);
  const lines = summarizeRefreshAll(plan, { a: { ok: true } });
  assert.equal(lines[0], "A: refreshed.");
  assert.ok(lines.slice(1).every((l) => /not refreshed/.test(l)));
  assert.match(summarizeRefreshAll(plan, { a: { ok: false, reason: "anchor-mismatch" } })[0], /not refreshed \(page layout changed, use Re-track\)/);
});

test("refresh all reads another open site only after that exact site is allowed", () => {
  const ts = [{ id: "a", label: "A", urlPattern: "https://a.test/" }, { id: "b", label: "B", urlPattern: "https://b.test/" }];
  const tabs = [{ id: 1, url: "https://a.test/x" }, { id: 7, url: "https://b.test/y" }];
  const before = planRefreshAll(ts, "https://a.test/x", tabs, []);
  assert.deepEqual(before[1], { id: "b", label: "B", action: "allow", tabId: 7, origin: "https://b.test/*", host: "b.test" });
  assert.match(summarizeRefreshAll(before, { a: { ok: true } })[1], /needs your OK to read b\.test\)\. Click Allow/);
  const after = planRefreshAll(ts, "https://a.test/x", tabs, ["https://b.test/*"]);
  assert.deepEqual(after[1], { id: "b", label: "B", action: "read", tabId: 7 });
  const other = planRefreshAll(ts, "https://a.test/x", tabs, ["https://c.test/*"]);
  assert.equal(other[1].action, "allow");
});

test("Meta pages and non-https pages are never offered a permission", () => {
  const ts = [{ id: "m", label: "M", urlPattern: "https://dev.meta.ai/" }, { id: "n", label: "N", urlPattern: "http://n.test/" }];
  const tabs = [{ id: 3, url: "https://dev.meta.ai/usage" }, { id: 4, url: "http://n.test/p" }];
  const plan = planRefreshAll(ts, "https://other.test/", tabs, ["https://dev.meta.ai/*"]);
  assert.deepEqual(plan.map((p) => p.action), ["switch", "switch"]);
  assert.equal(originPattern("http://n.test/p"), null);
  assert.equal(originPattern("https://b.test/y?q=1"), "https://b.test/*");
  for (const h of ["meta.ai", "dev.meta.ai", "billing.dev.meta.ai"]) assert.equal(isMetaHost(h), true);
  assert.equal(isMetaHost("notmeta.ai"), false);
  assert.equal(isMetaHost("meta.ai.evil.test"), false);
});

test("the manifest declares optional https access only and no default host access", async () => {
  const { readFileSync } = await import("node:fs");
  const m = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(m.host_permissions, []);
  assert.deepEqual(m.optional_host_permissions, ["https://*/*"]);
});
