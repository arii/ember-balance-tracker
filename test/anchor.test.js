import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import { ebtAnchor } from "../src/lib/anchor.js";

// Stub chrome API for background.js dynamic imports
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

// Helper: extract a function definition by name from source using brace matching.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Function ${name} not found`);
  let i = source.indexOf("{", start);
  if (i === -1) throw new Error(`Brace not found for ${name}`);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

// Normalize a function source: strip "export " and trim leading whitespace per line.
function normalizeFunction(src) {
  return src.replace(/^export\s+/, "").split("\n").map((line) => line.trimStart()).join("\n").trim();
}

// Helper to create a JSDOM window from an HTML string.
function makeDom(html) {
  return new JSDOM(html, { runScripts: "outside-only" });
}

// Helper to get readAtFunc evaluated in a given dom.
function getReadAtFunc(dom) {
  const src = fs.readFileSync("src/background.js", "utf8");
  const funcSrc = extractFunction(src, "readAtFunc");
  return dom.window.eval("(" + funcSrc + ")");
}

test("ebtAnchor: Runware-like tile returns label", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$100.05</div>
    </div>
  `);
  const el = dom.window.document.querySelector(".v");
  assert.equal(ebtAnchor(el), "balance");
});

test("ebtAnchor: Spend tile returns 'spend (30d)'", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Spend (30d)</span></div>
      <div class="v">$1,234.56</div>
    </div>
  `);
  const el = dom.window.document.querySelector(".v");
  assert.equal(ebtAnchor(el), "spend (30d)");
});

test("ebtAnchor: element with no label ancestor returns null", () => {
  const dom = makeDom(`<div><div class="v">42</div></div>`);
  const el = dom.window.document.querySelector(".v");
  assert.equal(ebtAnchor(el), null);
});

test("Text identity: ebtAnchor function is identical across files", () => {
  const files = ["src/lib/anchor.js", "src/content/content.js", "src/background.js"];
  const sources = files.map((f) => fs.readFileSync(f, "utf8"));
  const funcs = sources.map((src) => normalizeFunction(extractFunction(src, "ebtAnchor")));
  const [a, b, c] = funcs;
  assert.equal(a, b);
  assert.equal(a, c);
});

test("readAtFunc: healed when anchor matches a different tile", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$100.05</div>
    </div>
    <div class="card">
      <div><span>Spend (30d)</span></div>
      <div class="v">$500.00</div>
    </div>
  `);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".card:nth-of-type(2) .v", "balance");
  assert.deepEqual({...result}, { ok: true, text: "$100.05", verified: true, healed: true });
  assert.notEqual(result.text, "$0.00");
});

test("readAtFunc: healed to value when label contains digit and selector points to spend tile", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$100.05</div>
    </div>
    <div class="card">
      <div><span>Spend (30d)</span></div>
      <div class="v">$500.00</div>
    </div>
  `);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".card:nth-of-type(2) .v", "balance");
  assert.deepEqual({...result}, { ok: true, text: "$100.05", verified: true, healed: true });
});

test("readAtFunc: verified when selector points to correct anchor", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$100.05</div>
    </div>
  `);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".card .v", "balance");
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.ok(!result.healed);
  assert.notEqual(result.text, "$0.00");
});

test("readAtFunc: ambiguous when multiple tiles share the same anchor", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$100.05</div>
    </div>
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$200.10</div>
    </div>
    <div class="card">
      <div><span>Spend</span></div>
      <div class="v">$50.00</div>
    </div>
  `);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".spend .v", "balance");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "anchor-ambiguous");
  assert.notEqual(result.text, "$0.00");
});

test("readAtFunc: ambiguous when second Balance tile inserted above selector points to wrong tile", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$999.00</div>
    </div>
    <div class="card">
      <div><span>Balance</span></div>
      <div class="v">$100.05</div>
    </div>
  `);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".card:nth-of-type(2) .v", "balance");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "anchor-ambiguous");
  assert.equal(result.text, undefined);
});

test("readAtFunc: mismatch when anchor missing but selector exists", () => {
  const dom = makeDom(`
    <div class="card">
      <div><span>Spend</span></div>
      <div class="v">$50.00</div>
    </div>
  `);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".card .v", "balance");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "anchor-mismatch");
  assert.notEqual(result.text, "$0.00");
});

test("readAtFunc: selector-not-found when both selector and anchor missing", () => {
  const dom = makeDom(`<div><span>No tiles</span></div>`);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".missing", "balance");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "selector-not-found");
  assert.notEqual(result.text, "$0.00");
});

test("readAtFunc: legacy tracker with null anchor returns text", () => {
  const dom = makeDom(`<div class="card"><span>Balance</span><div class="v">$100.05</div></div>`);
  const readAt = getReadAtFunc(dom);
  const result = readAt(".card .v", null);
  assert.equal(result.ok, true);
  assert.equal(result.verified, false);
  assert.equal(result.text, "$100.05");
  assert.equal(result.healed, undefined);
});

test("pickFrameResult: passes verified/healed through for ok result", async () => {
  const { pickFrameResult } = await import("../src/background.js");
  const results = [
    { ok: false, result: { ok: false, reason: "selector-not-found" } },
    { ok: true, result: { ok: true, text: "$100.05", verified: true, healed: false } },
  ];
  const out = pickFrameResult(results);
  assert.equal(out.ok, true);
  assert.equal(out.text, "$100.05");
  assert.equal(out.verified, true);
  assert.equal(out.healed, false);
});

test("pickFrameResult: anchor-mismatch wins over selector-not-found", async () => {
  const { pickFrameResult } = await import("../src/background.js");
  const results = [
    { ok: false, result: { ok: false, reason: "selector-not-found" } },
    { ok: false, result: { ok: false, reason: "anchor-mismatch" } },
  ];
  const out = pickFrameResult(results);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "anchor-mismatch");
});

test("pickFrameResult: falls back to selector-not-found when only that exists", async () => {
  const { pickFrameResult } = await import("../src/background.js");
  const results = [
    { ok: false, result: { ok: false, reason: "selector-not-found" } },
    { ok: false, result: { ok: false, reason: "selector-not-found" } },
  ];
  const out = pickFrameResult(results);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "selector-not-found");
});
