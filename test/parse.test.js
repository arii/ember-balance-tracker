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

test("parses negative currency balances (overdrawn)", () => {
  assert.equal(parseBalance("Available Balance: -$5.20").value, -5.2);
  assert.equal(parseBalance("-$0.50").value, -0.5);
  assert.equal(parseBalance("Wallet balance -$12.00").value, -12);
});

test("minus must attach to the amount, not sit inside a hyphenated token", () => {
  // "AC-8812" is an identifier; its hyphen is not a sign
  assert.equal(parseBalance("Account ID: AC-8812").value, 8812);
  // and a spaced dash before an amount is punctuation, not a sign
  assert.equal(parseBalance("Balance - $5.20").value, 5.2);
});

test("parses decimal-comma amounts (pt-BR / EU)", () => {
  assert.equal(parseBalance("Saldo Disponível: R$ 12.890,50").value, 12890.5);
  assert.equal(parseBalance("R$ 1.234.567,89").value, 1234567.89);
  assert.equal(parseBalance("Saldo: 1234,56").value, 1234.56);
  assert.equal(parseBalance("12.890,50 credits").value, 12890.5);
});

test("US formats unchanged with decimal-comma support", () => {
  assert.equal(parseBalance("$1,250.50").value, 1250.5);
  assert.equal(parseBalance("1,250 credits").value, 1250);
  assert.equal(parseBalance("100,000").value, 100000);
  assert.equal(parseBalance("0 of 20,000 credits used").total, 20000);
  assert.equal(parseBalance("$100.05").value, 100.05);
});

test("accounting parentheses mean negative only for the sole number", () => {
  assert.equal(parseBalance("($5.20)").value, -5.2);
  assert.equal(parseBalance("Balance: (1,234.56)").value, -1234.56);
  assert.equal(parseBalance("Balance $100.05 (min $50.00)").value, 100.05);
});

test("K and M suffixes glued to digits expand; MB, minutes and spaced units do not", () => {
  assert.equal(parseBalance("12K").value, 12000);
  assert.equal(parseBalance("1.2k").value, 1200);
  assert.equal(parseBalance("1.5M").value, 1500000);
  assert.equal(parseBalance("12 MB").value, 12);
  assert.equal(parseBalance("5m left").value, 5);
  assert.equal(parseBalance("12KB").value, 12);
});

test("apostrophe thousands grouping is read as one number", () => {
  assert.equal(parseBalance("CHF 1'234.56").value, 1234.56);
  assert.equal(parseBalance("1’234’567").value, 1234567);
});

test("parentheses and suffix edge cases stay conservative", () => {
  assert.equal(parseBalance("Credits (5) remaining").value, 5);
  assert.equal(parseBalance("(5) credits").value, 5);
  assert.equal(parseBalance("Total (1,234.56) USD").value, 1234.56);
  assert.equal(parseBalance("Balance (pending) $5.00").value, 5);
  assert.equal(parseBalance("Balance $100.05 (3 pending)").value, 100.05);
  assert.equal(parseBalance("($1,234.56)").value, -1234.56);
  assert.equal(parseBalance("(-5.00)").value, -5);
  assert.equal(parseBalance("2K24").value, 2);
  assert.equal(parseBalance("12K of 50K credits").total, 50000);
});
