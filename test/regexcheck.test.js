import { test } from "node:test";
import assert from "node:assert/strict";
import { safeCompile, extractWithPattern, validatePattern } from "../src/lib/regexcheck.js";

test("compiles a plain pattern", () => {
  assert.ok(safeCompile("\\$([\\d,]+(?:\\.\\d+)?)"));
});

test("rejects dangerous and broken patterns", () => {
  assert.equal(safeCompile("(a+)+$"), null); // nested quantified group
  assert.equal(safeCompile("(\\w\\s*)*$"), null); // nested quantified group
  assert.equal(safeCompile(".*.*.*x"), null); // .*.* chain
  assert.equal(safeCompile("(a|a)*$"), null); // ambiguous quantified alternation
  assert.equal(safeCompile("(a|ab)+c"), null); // overlapping alternation branches
  assert.equal(safeCompile("(x)\\1"), null); // backreference
  assert.equal(safeCompile("a{1,99999}"), null); // huge repeat
  assert.equal(safeCompile("(unclosed"), null);
  assert.equal(safeCompile("x".repeat(300)), null);
  assert.equal(safeCompile(42), null);
});

test("adversarial input on accepted patterns stays fast", () => {
  const evil = "a".repeat(4999) + "!";
  const start = Date.now();
  const r = extractWithPattern(evil, "\\$([\\d.]+)");
  assert.equal(r.ok, false);
  assert.ok(Date.now() - start < 500, "match over capped input is fast");
});

test("input is capped at 5000 chars", () => {
  const text = "noise ".repeat(5000) + "$5";
  const r = extractWithPattern(text, "\\$([\\d.]+)");
  assert.equal(r.ok, false); // the match sits beyond the cap, so it is not read
});

test("extracts via capture group", () => {
  const r = extractWithPattern("Available balance $100.05 today", "\\$([\\d.]+)");
  assert.equal(r.ok, true);
  assert.equal(r.value, 100.05);
});

test("no match is a clean failure", () => {
  assert.equal(extractWithPattern("nothing here", "\\d+ credits").ok, false);
});

test("validatePattern accepts only patterns reproducing the training value", () => {
  const text = "Balance: $100.05";
  assert.equal(validatePattern("\\$([\\d.]+)", text, 100.05).accepted, true);
  assert.equal(validatePattern("(\\d+)", text, 999).accepted, false); // wrong value
  assert.equal(validatePattern("zzz", text, 100.05).accepted, false); // no match
});
