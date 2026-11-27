// Multi-frame read merging, tested against the real background.js exports.
import { test, before } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} } },
  storage: {
    local: {
      async get() { return {}; },
      async set() {},
    },
    session: {
      async get() { return {}; },
      async set() {},
      async remove() {},
    },
  },
};

let pickFrameResult, joinFrameTexts;
before(async () => {
  ({ pickFrameResult, joinFrameTexts } = await import("../src/background.js"));
});

test("a hit in any frame wins over misses in other frames", () => {
  const res = pickFrameResult([
    { frameId: 0, result: { ok: false, reason: "selector-not-found" } },
    { frameId: 1, result: { ok: true, text: "$106.34" } },
  ]);
  assert.deepEqual(res, { ok: true, text: "$106.34", verified: false, healed: false });
});

test("first-frame hit wins without waiting for other frames", () => {
  const res = pickFrameResult([
    { frameId: 0, result: { ok: true, text: "$0.00" } },
    { frameId: 1, result: { ok: false, reason: "selector-not-found" } },
  ]);
  assert.deepEqual(res, { ok: true, text: "$0.00", verified: false, healed: false });
});

test("all frames missing is the honest re-teach state", () => {
  const res = pickFrameResult([
    { frameId: 0, result: { ok: false, reason: "selector-not-found" } },
    { frameId: 1, result: { ok: false, reason: "selector-not-found" } },
  ]);
  assert.deepEqual(res, { ok: false, reason: "selector-not-found" });
});

test("an informative failure beats a plain miss", () => {
  const res = pickFrameResult([
    { frameId: 0, result: { ok: false, reason: "selector-not-found" } },
    { frameId: 1, result: { ok: false, reason: "empty" } },
  ]);
  assert.deepEqual(res, { ok: false, reason: "empty" });
});

test("no frame results is a clean failure, never a crash", () => {
  assert.deepEqual(pickFrameResult([]), { ok: false, reason: "no-frames" });
  assert.deepEqual(pickFrameResult(undefined), { ok: false, reason: "no-frames" });
  assert.deepEqual(pickFrameResult([{ frameId: 0 }]), { ok: false, reason: "selector-not-found" });
});

test("frame texts join without duplication and respect the cap", () => {
  const joined = joinFrameTexts([
    { frameId: 0, result: "Billing overview" },
    { frameId: 1, result: "Outstanding balance $0.00 Free credits $106.34" },
    { frameId: 2, result: "Outstanding balance $0.00 Free credits $106.34" },
    { frameId: 3, result: "  " },
    { frameId: 4, result: null },
  ]);
  assert.equal(joined, "Billing overview\nOutstanding balance $0.00 Free credits $106.34");
  assert.equal(joinFrameTexts([{ result: "abcdefghij" }], 4), "abcd");
  assert.equal(joinFrameTexts([]), "");
});
