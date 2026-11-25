// Regression: chrome.scripting.executeScript injects content.js as a CLASSIC
// script (the installed-extension path - popup > Track this balance >
// background injection). A module-only feature such as import.meta is a
// parse-time SyntaxError there and silently kills the whole picker flow on
// real Chrome (found 2026-11-25: installed-extension training never armed).
// The old e2e missed it because it injected content.js as a module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("content.js parses as a classic script (executeScript injection mode)", () => {
  const src = readFileSync(path.join(root, "src", "content", "content.js"), "utf8");
  // vm.Script compiles in classic-script mode: import.meta / static imports throw.
  assert.doesNotThrow(() => new vm.Script(src, { filename: "content.js" }));
});

test("content.js contains no module-only syntax", () => {
  const raw = readFileSync(path.join(root, "src", "content", "content.js"), "utf8");
  const src = raw.replace(/\/\/[^\n]*/g, ""); // strip line comments
  assert.equal(/\bimport\.meta\b/.test(src), false, "import.meta is illegal in classic scripts");
  assert.equal(/^\s*import\s+/m.test(src), false, "static import is illegal in classic scripts");
  assert.equal(/^\s*export\s+/m.test(src), false, "export is illegal in classic scripts");
});


test("classic injection registers the production async message listener", async () => {
  const src = readFileSync(path.join(root, "src", "content", "content.js"), "utf8");
  let listener;
  const context = vm.createContext({
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    document: { querySelector(selector) {
      return selector === "#balance" ? { innerText: "$100.05" } : null;
    } },
  });
  new vm.Script(src).runInContext(context);
  assert.equal(typeof listener, "function");
  let response;
  assert.equal(listener({ type: "ebt:read", selector: "#balance" }, {}, value => { response = value; }), true);
  assert.equal(response.ok, true);
  assert.equal(response.text, "$100.05");
});
