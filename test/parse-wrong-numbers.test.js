import { test } from "node:test";
import assert from "node:assert/strict";
const sub = (r) => { const { raw, ...rest } = r; return rest; };
import { parseBalance as pb } from "../src/lib/parse.js";

test("A: dates are not used-of-total", () => {
  assert.deepEqual(sub(pb("Updated 11/26 balance $4.20")), { ok: true, value: 4.2, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("Balance: $100.05 (expires 12/31)")), { ok: true, value: 100.05, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("Balance: $100.05 as of 11/26/2025")), { ok: true, value: 100.05, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("$100.05 (updated 1/5)")), { ok: true, value: 100.05, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("Next billing 12/31: 42 credits remain")), { ok: true, value: 42, unit: "credits", kind: "unit" });
});

test("A non-regression: used-of-total still works", () => {
  let r = pb("500 / 2000 credits");
  assert.equal(r.kind, "used-of-total"); assert.equal(r.value, 500); assert.equal(r.total, 2000);
  r = pb("0 of 20,000 credits used");
  assert.equal(r.kind, "used-of-total"); assert.equal(r.value, 0); assert.equal(r.total, 20000);
  r = pb("3/10 credits used");
  assert.equal(r.kind, "used-of-total"); assert.equal(r.value, 3); assert.equal(r.total, 10);
  r = pb("3 of 10");
  assert.equal(r.kind, "used-of-total"); assert.equal(r.value, 3); assert.equal(r.total, 10);
});

test("B: leading dot decimals", () => {
  assert.deepEqual(sub(pb("$.50")), { ok: true, value: 0.5, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("£.5")), { ok: true, value: 0.5, unit: "$", kind: "currency" });
});

test("C: space-grouped thousands", () => {
  assert.deepEqual(sub(pb("Credits: 1 234,56")), { ok: true, value: 1234.56, unit: null, kind: "bare" });
  assert.deepEqual(sub(pb("1 234,56 €")), { ok: true, value: 1234.56, unit: null, kind: "bare" });
  assert.deepEqual(sub(pb("Balance 12 345.67 USD")), { ok: true, value: 12345.67, unit: null, kind: "bare" });
  assert.equal(pb("10 000 tokens").value, 10000);
});

test("D: minus variants", () => {
  assert.deepEqual(sub(pb("−$5.20")), { ok: true, value: -5.2, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("$-5.20")), { ok: true, value: -5.2, unit: "$", kind: "currency" });
  assert.equal(pb("Balance - $5.20").value, 5.2);
});

test("non-regression: common cases", () => {
  assert.deepEqual(sub(pb("$100.05")), { ok: true, value: 100.05, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("4,000 credits")), { ok: true, value: 4000, unit: "credits", kind: "unit" });
  assert.deepEqual(sub(pb("R$ 12.890,50")), { ok: true, value: 12890.5, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("($5.20)")), { ok: true, value: -5.2, unit: "$", kind: "currency" });
  assert.deepEqual(sub(pb("AC-8812")), { ok: true, value: 8812, unit: null, kind: "bare" });
});

test("review follow-ups: bare 3/10 stays used-of-total, year-first dates skipped", () => {
  const r = pb("3/10");
  assert.equal(r.kind, "used-of-total"); assert.equal(r.value, 3); assert.equal(r.total, 10);
  assert.equal(pb("Expires 2025/06 balance $7.00").value, 7);
});
