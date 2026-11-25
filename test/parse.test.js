import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBalance } from "../src/lib/parse.js";

test("parses dollar amounts", () => {
  assert.deepEqual(parseBalance("$100.05"), { ok: true, value: 100.05, unit: "$", raw: "$100.05", kind: "currency" });
  assert.equal(parseBalance("USD 44.99").value, 44.99);
});

test("parses grouped numbers with unit words", () => {
  const r = parseBalance("4,000 credits");
  assert.equal(r.value, 4000);
  assert.equal(r.unit, "credits");
  assert.equal(parseBalance("127 CR").value, 127);
  assert.equal(parseBalance("10 points").value, 10);
});

test("parses used-of-total", () => {
  const r = parseBalance("0 of 20,000 credits used");
  assert.equal(r.kind, "used-of-total");
  assert.equal(r.value, 0);
  assert.equal(r.total, 20000);
  assert.equal(r.unit, "credits");
});

test("parses inside surrounding text", () => {
  const r = parseBalance("Available balance $100.05");
  assert.equal(r.value, 100.05);
});

test("rejects empty and non-strings", () => {
  assert.equal(parseBalance("").ok, false);
  assert.equal(parseBalance(null).ok, false);
  assert.equal(parseBalance("no numbers here").ok, false);
});

test("bare number fallback", () => {
  const r = parseBalance("Balance: 100.05");
  assert.equal(r.value, 100.05);
  assert.equal(r.kind, "bare");
});
