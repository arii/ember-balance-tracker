import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMeta, titleFor, isStale, isUnverified } from "../src/lib/format.js";

test("isStale: false when no lastFailure", () => {
  const t = { history: [{ ts: 1000, value: 1 }] };
  assert.equal(isStale(t), false);
});

test("isStale: true when lastFailure.ts later than last history ts", () => {
  const t = {
    lastFailure: { ts: 2000, reason: "anchor-mismatch" },
    history: [{ ts: 1000, value: 1 }],
  };
  assert.equal(isStale(t), true);
  const meta = formatMeta(t);
  assert.ok(meta.startsWith("Out of date:"));
  assert.ok(meta.includes("Out of date") && !meta.includes("latest check failed"));
  const title = titleFor(t);
  assert.ok(title.includes("Last read failed: anchor-mismatch"));
});

test("isStale: false when lastFailure older than last read", () => {
  const t = {
    lastFailure: { ts: 500, reason: "x" },
    history: [{ ts: 1000, value: 1 }],
  };
  assert.equal(isStale(t), false);
});

test("isUnverified: true for legacy tracker without verified field", () => {
  const t = { history: [{ ts: 1000, value: 1 }], anchor: null };
  assert.equal(isUnverified(t), true);
  const meta = formatMeta(t);
  assert.ok(meta.endsWith(" - unverified"));
});

test("isUnverified: false when anchor exists", () => {
  const t = { history: [{ ts: 1000, value: 1, verified: false }], anchor: "balance" };
  assert.equal(isUnverified(t), false);
});

test("isUnverified: false when no history", () => {
  const t = {};
  assert.equal(isUnverified(t), false);
});

test("formatMeta: 'never read' when no history", () => {
  const t = {};
  assert.equal(formatMeta(t), "never read");
});
