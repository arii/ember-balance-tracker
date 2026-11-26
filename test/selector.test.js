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


test("deep repeated dashboard cards get distinct unique paths", () => {
  const card = value => `<section>${"<div>".repeat(7)}<span>${value}</span>${"</div>".repeat(7)}</section>`;
  const d = new JSDOM(`<main>${card("$1.00")}${card("$100.05")}</main>`).window.document;
  const el = [...d.querySelectorAll("span")][1];
  const sel = getSelector(el);
  assert.equal(d.querySelectorAll(sel).length, 1);
  assert.equal(d.querySelector(sel), el);
});

test("duplicate IDs and data attributes never select another balance", () => {
  const d = new JSDOM('<main><div id="balance" data-testid="amount">$1</div><div id="balance" data-testid="amount">$100</div></main>').window.document;
  const el = d.querySelectorAll("div")[1];
  const sel = getSelector(el);
  assert.equal(d.querySelectorAll(sel).length, 1);
  assert.equal(d.querySelector(sel), el);
});

test("ancestor IDs do not add a nonexistent extra child segment", () => {
  const d = new JSDOM('<section id="account"><div><span>$100</span></div></section>').window.document;
  const el = d.querySelector("span");
  assert.equal(d.querySelector(getSelector(el)), el);
});

test("unselectable detached elements fail instead of returning misleading selector", () => {
  const d = new JSDOM('<main></main>').window.document;
  assert.throws(() => getSelector(d.createElement("span")), /not uniquely selectable/);
});

test("data attribute selectors handle literal backslashes and quotes", () => {
  const d = new JSDOM('<main><span>$100</span></main>').window.document;
  const el = d.querySelector("span");
  el.setAttribute("data-testid", 'billing\\value"amount');
  assert.equal(d.querySelector(getSelector(el)), el);
});
