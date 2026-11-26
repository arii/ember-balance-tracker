// Fixture-driven extraction tests over the Adaption-generated evaluation set
// (test/fixtures/adaption-balance-pages.json): 98 realistic fictional AI-service
// billing/usage page texts, each with the correct available-balance extraction
// ({ balance, unit, label }) plus a precomputed `snippet` (label..value window,
// shaped like the text of the element a user would click) and `value_string`.
//
// Three layers are exercised against the real code paths:
//   1. parseBalance over the labeled snippet (the deterministic read layer).
//   2. extractWithPattern over the FULL page text with a label-anchored
//      safe-subset pattern (distractor robustness of the regex read layer).
//   3. validatePattern over the same pattern+snippet (train-time acceptance).
//
// Fixtures 54 (decimal-comma "R$ 12.890,50") and 68 (negative "-$5.20")
// originally pinned parser bugs as known limitations; parse.js now handles
// both, so every fixture asserts the correct expected value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBalance } from "../src/lib/parse.js";
import { extractWithPattern, validatePattern, safeCompile } from "../src/lib/regexcheck.js";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/adaption-balance-pages.json", import.meta.url), "utf8"),
);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wsFlex = (s) => esc(s).replace(/\s+/g, "\\s+");

// Label, optional punctuation and currency marker, then the number. Bounded
// repeats only (safe-subset): no greedy wildcards, no nested quantifiers.
const anchorPattern = (label) =>
  `${wsFlex(label)}\\s*[:\\-–]?\\s*(-?\\s*R?[$€£]?\\s*\\d[\\d.,]*)`;

const active = fixtures;

for (const f of active) {
  test(`fixture ${f.id}: parseBalance reads labeled snippet`, () => {
    assert.ok(f.page_text.includes(f.snippet), "snippet must come from page text");
    const r = parseBalance(f.snippet);
    assert.equal(r.ok, true, `no parse: ${f.snippet.slice(0, 120)}`);
    assert.equal(r.value, f.balance, `snippet: ${f.snippet.slice(0, 160)}`);
  });

  test(`fixture ${f.id}: anchored pattern survives full-page distractors`, () => {
    const pattern = anchorPattern(f.label);
    assert.ok(safeCompile(pattern), `pattern rejected by safeCompile: ${pattern}`);
    const r = extractWithPattern(f.page_text, pattern);
    assert.equal(r.ok, true, `no extraction: ${r.reason ?? ""}`);
    assert.equal(r.value, f.balance, `matched: ${(r.matched ?? "").slice(0, 120)}`);
  });

  test(`fixture ${f.id}: validatePattern accepts pattern that reproduces trained value`, () => {
    const v = validatePattern(anchorPattern(f.label), f.snippet, f.balance);
    assert.equal(v.accepted, true, `rejected: ${v.reason ?? ""}`);
  });
}

