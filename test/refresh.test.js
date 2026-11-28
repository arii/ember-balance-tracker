import { test } from "node:test";
import assert from "node:assert/strict";
import { dueForTab, badgeFor, DUE_AFTER_MS } from "../src/lib/autoread.js";
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
