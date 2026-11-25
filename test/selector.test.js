import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { getSelector } from "../src/lib/selector.js";

const dom = new JSDOM(`<!doctype html><body>
  <main><div class="metric"><div class="k">Available balance</div><div class="v" id="balance">$100.05</div></div>
  <div class="metric"><div class="v" data-testid="monthly-credits">2,000 credits</div></div>
  <section><p>one</p><p>two</p></section></main>
</body>`);
const doc = dom.window.document;

test("prefers stable id", () => {
  const el = doc.querySelector("#balance");
  assert.equal(getSelector(el), "#balance");
});

test("uses data-testid when no id", () => {
  const el = doc.querySelector('[data-testid="monthly-credits"]');
  assert.equal(getSelector(el), 'div[data-testid="monthly-credits"]');
});

test("builds nth-of-type path otherwise", () => {
  const el = doc.querySelectorAll("section p")[1];
  const sel = getSelector(el);
  assert.ok(sel.includes("p:nth-of-type(2)"), sel);
  assert.equal(doc.querySelector(sel), el, "selector resolves back to the element");
});

test("rejects unstable auto-generated ids", () => {
  const d2 = new JSDOM('<div id="a123456789">x</div>').window.document;
  const sel = getSelector(d2.querySelector("div"));
  assert.notEqual(sel, "#a123456789");
  assert.equal(d2.querySelector(sel), d2.querySelector("div"));
});
