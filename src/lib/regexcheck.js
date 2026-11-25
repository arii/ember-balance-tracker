// Safe handling of model-derived regex patterns.
// Threat model: the pattern comes from Muse Ember (model output, could be wrong
// or weird); the input text comes from arbitrary web pages (untrusted). A
// catastrophic-backtracking pattern plus hostile input could hang the tab's
// service worker. There is no regex timeout in JS, so defense is by subset
// restriction + input caps, validated by adversarial tests. No `eval`, no
// generated executable code: a pattern is data compiled with `new RegExp`.

import { parseBalance } from "./parse.js";

const MAX_PATTERN_LEN = 200;
const MAX_INPUT_LEN = 5000;
const MAX_REPEAT = 64; // upper bound allowed in {n,m} quantifiers

function hasBackreference(pattern) {
  // \1..\9, \k<name> backreferences enable exponential matching on some inputs
  return /\\[1-9]|\\k</.test(pattern);
}

function hasLargeRepeat(pattern) {
  for (const m of pattern.matchAll(/\{(\d+)(?:,(\d*)?)\}/g)) {
    const upper = m[2] === undefined || m[2] === "" ? Number(m[1]) : Number(m[2]);
    if (upper > MAX_REPEAT) return true;
  }
  return false;
}

// Nested quantified groups: a group whose body contains a quantifier and which
// is itself quantified, e.g. (a+)+ (\w\s*)* ((ab|a)+)* — the classic ReDoS shape.
// Small hand parser: track group stack; flag when a quantifier closes a group
// that contains a quantifier.
function hasNestedQuantifiedGroup(pattern) {
  const stack = []; // each entry: true if group body saw a quantifier
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; } // skip escaped char
    if (c === "[") { // skip character class
      i++;
      while (i < pattern.length && pattern[i] !== "]") { if (pattern[i] === "\\") i++; i++; }
      continue;
    }
    if (c === "(") stack.push(false);
    else if (c === ")") {
      const sawQuant = stack.pop() ?? false;
      const next = pattern[i + 1];
      // "?" (0-or-1) cannot multiply paths; +, *, {n,m} can.
      const quantified = next === "+" || next === "*" || next === "{";
      if (sawQuant && quantified) return true;
      if (stack.length && (sawQuant || quantified)) stack[stack.length - 1] = true;
    } else if (c === "+" || c === "*" || (c === "?" && pattern[i - 1] !== "(")) {
      if (stack.length) stack[stack.length - 1] = true;
    }
  }
  return false;
}

// Ambiguous alternation inside a quantified group: (a|a)*, (a|ab)+ — two
// branches that can start matching the same character give exponential paths
// on non-matching input. Heuristic: reject when any two top-level branches of
// a quantified group share a first literal character.
function hasAmbiguousQuantifiedAlternation(pattern) {
  const stack = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") { i++; while (i < pattern.length && pattern[i] !== "]") { if (pattern[i] === "\\") i++; i++; } continue; }
    if (c === "(") stack.push({ branches: [[]], depth: 0 });
    else if (c === "|") { const g = stack[stack.length - 1]; if (g && g.depth === 0) g.branches.push([]); }
    else if (c === ")") {
      const g = stack.pop();
      const quantified = ["+", "*", "?", "{"].includes(pattern[i + 1]);
      if (g && quantified && g.branches.length > 1) {
        const firsts = g.branches.map((b) => b[0]).filter(Boolean);
        if (new Set(firsts).size !== firsts.length) return true;
      }
      if (stack.length) stack[stack.length - 1].depth++;
    } else {
      const g = stack[stack.length - 1];
      if (g && g.depth === 0 && /[A-Za-z0-9\s$.]/.test(c)) g.branches[g.branches.length - 1].push(c);
    }
  }
  return false;
}

/**
 * Compile a candidate pattern string into a RegExp, or return null when it is
 * outside the safe subset. Flags: case-insensitive, single match.
 */
// Two or more greedy wildcards (.* / .+) give quadratic-plus backtracking on
// non-matching input; one is plenty for an extraction pattern.
function hasMultipleGreedyWildcards(pattern) {
  let count = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") { i++; while (i < pattern.length && pattern[i] !== "]") { if (pattern[i] === "\\") i++; i++; } continue; }
    if (c === "." && (pattern[i + 1] === "*" || pattern[i + 1] === "+")) { count++; i++; }
  }
  return count > 1;
}

export function safeCompile(pattern) {
  if (typeof pattern !== "string") return null;
  const p = pattern.trim();
  if (!p || p.length > MAX_PATTERN_LEN) return null;
  if (hasBackreference(p) || hasLargeRepeat(p) || hasNestedQuantifiedGroup(p) || hasAmbiguousQuantifiedAlternation(p) || hasMultipleGreedyWildcards(p)) return null;
  try {
    return new RegExp(p, "i");
  } catch {
    return null;
  }
}

/**
 * Extract a balance from text using a candidate pattern.
 * Input is capped at MAX_INPUT_LEN before matching. Uses the first capture
 * group when present, else the full match.
 */
export function extractWithPattern(text, pattern) {
  const re = safeCompile(pattern);
  if (!re || typeof text !== "string") return { ok: false, reason: "bad-pattern" };
  const input = text.length > MAX_INPUT_LEN ? text.slice(0, MAX_INPUT_LEN) : text;
  const m = input.match(re);
  if (!m) return { ok: false, reason: "no-match" };
  const parsed = parseBalance(m[1] ?? m[0]);
  return parsed.ok ? { ...parsed, matched: m[0] } : { ok: false, reason: "matched-unparseable", matched: m[0] };
}

/**
 * Accept a model-derived pattern only if it extracts the same value we saw
 * at training time from the same training text.
 */
export function validatePattern(pattern, trainingText, expectedValue) {
  const r = extractWithPattern(trainingText, pattern);
  if (!r.ok) return { accepted: false, reason: r.reason };
  if (expectedValue !== null && expectedValue !== undefined && r.value !== expectedValue) {
    return { accepted: false, reason: "value-mismatch", got: r.value };
  }
  return { accepted: true, pattern: pattern.trim() };
}

export const _internals = { hasNestedQuantifiedGroup, hasBackreference, hasLargeRepeat, hasAmbiguousQuantifiedAlternation, MAX_INPUT_LEN };
