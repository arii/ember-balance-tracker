// Production budget guard tested against the real background.js exports with
// a stubbed chrome.storage - no duplicated helper logic.
import { test, before } from "node:test";
import assert from "node:assert/strict";

const store = {};
globalThis.chrome = {
  runtime: { onMessage: { addListener() {} } },
  storage: {
    local: {
      async get(key) { return { [key]: store[key] }; },
      async set(obj) { Object.assign(store, obj); },
    },
  },
};

let reserveForSend, settleReservation;
before(async () => {
  ({ reserveForSend, settleReservation } = await import("../src/background.js"));
});

const reset = (settings = { maxSpendUsd: 1 }) => {
  store.settings = settings;
  store.emberTrace = [];
};

test("reservation persists before send and settles into the actual usage record", async () => {
  reset();
  const g = await reserveForSend({ bodyBytes: 2000, maxTokens: 1000 });
  assert.equal(g.allowed, true);
  assert.equal(store.emberTrace.length, 1);
  assert.equal(store.emberTrace[0].pending, true);
  // Provable bound: 1,048,576-token context window + 1000 output cap, both at
  // long-context rates (0.30 in / 1.50 out per Mtok) - no byte assumptions.
  assert.equal(store.emberTrace[0].reservedUsd, 0.3160728);
  await settleReservation({ trace: { ts: new Date().toISOString(), reservationId: g.reservationId, model: "muse-ember-1.0", ok: true, usageKnown: true, promptTokens: 72, completionTokens: 130, totalTokens: 202, costUsd: 0.000072 } }, { trackerId: "t1" });
  assert.equal(store.emberTrace.length, 1, "settle replaces, never duplicates");
  assert.equal(store.emberTrace[0].pending, undefined);
  assert.equal(store.emberTrace[0].costUsd, 0.000072);
  assert.equal(store.emberTrace[0].trackerId, "t1");
});

test("concurrent reserves are serialized: only what fits gets through", async () => {
  reset({ maxSpendUsd: 0.5 }); // fits one 0.3160728 reservation, not two
  const [a, b] = await Promise.all([
    reserveForSend({ bodyBytes: 2000, maxTokens: 1000 }),
    reserveForSend({ bodyBytes: 2000, maxTokens: 1000 }),
  ]);
  const allowed = [a, b].filter((x) => x.allowed);
  assert.equal(allowed.length, 1, `exactly one reservation fits the cap, got ${JSON.stringify([a, b])}`);
  const denied = [a, b].find((x) => !x.allowed);
  assert.equal(denied.reason, "budget-exceeded");
  assert.equal(store.emberTrace.length, 1);
});

test("a pending reservation from a crashed worker still spends its worst case", async () => {
  reset({ maxSpendUsd: 0.5 });
  const g = await reserveForSend({ bodyBytes: 2000, maxTokens: 1000 });
  assert.equal(g.allowed, true);
  // Simulate worker death: no settle. A fresh reserve must count the stale one.
  const next = await reserveForSend({ bodyBytes: 2000, maxTokens: 1000 });
  assert.equal(next.allowed, false);
  assert.equal(next.reason, "budget-exceeded");
});

test("invalid cap, invalid request shape, and tier breach all fail closed", async () => {
  reset({ maxSpendUsd: -3 });
  assert.equal((await reserveForSend({ bodyBytes: 100, maxTokens: 10 })).reason, "budget-cap-invalid");
  reset({ maxSpendUsd: "junk" });
  assert.equal((await reserveForSend({ bodyBytes: 100, maxTokens: 10 })).reason, "budget-cap-invalid");
  reset({ maxSpendUsd: 0.01 });
  assert.equal((await reserveForSend({ bodyBytes: NaN, maxTokens: 10 })).reason, "budget-request-invalid");
  assert.equal((await reserveForSend({ bodyBytes: 100, maxTokens: 0 })).reason, "budget-request-invalid");
  assert.equal((await reserveForSend({ bodyBytes: 200001, maxTokens: 10 })).reason, "budget-tier-bound-exceeded");
  assert.equal(store.emberTrace.length, 0, "no reservations written by denied gates");
});

test("unknown-cost history blocks further spend until resolved", async () => {
  reset({ maxSpendUsd: 100 });
  store.emberTrace = [{ ts: new Date().toISOString(), ok: false, status: 500, error: "http-500", usageKnown: false, costUsd: null }];
  const g = await reserveForSend({ bodyBytes: 100, maxTokens: 10 });
  assert.equal(g.allowed, false);
  assert.equal(g.reason, "budget-cost-unknown");
});
