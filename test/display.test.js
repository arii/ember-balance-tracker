import test from "node:test";
import assert from "node:assert/strict";
import { readingView, displayValue, validateDisplay, foreignSameSiteFrames } from "../src/lib/display.js";
import { parseBalance } from "../src/lib/parse.js";

const bal = (extra = {}) => ({ history: [{ value: 106.2, unit: "$", kind: "currency" }], ...extra });

test("a plain balance has no total and never invents one", () => {
  const v = readingView(bal());
  assert.equal(v.total, null);
  assert.equal(v.percent, null);
  assert.equal(displayValue(bal({ display: "percent" })), "$106.20"); // falls back to amount, not 100%
});

test("percent left uses only the total the user typed", () => {
  const t = bal({ total: 200, display: "percent" });
  assert.equal(readingView(t).totalSource, "you");
  assert.equal(displayValue(t), "53.1% left");
  assert.equal(displayValue({ ...t, display: "amount" }), "$106.20");
});

test("page 'used of total' gives remaining amount and percent from the page total", () => {
  const p = parseBalance("0 of 20,000 credits used");
  const t = { history: [{ value: p.value, unit: p.unit, kind: p.kind, total: p.total }], display: "percent" };
  assert.equal(displayValue(t), "100% left");
  assert.equal(displayValue({ ...t, display: "amount" }), "20,000 credits left");
  const used = { history: [{ value: 5000, unit: "credits", kind: "used-of-total", total: 20000 }] };
  assert.equal(readingView(used).remaining, 15000);
  assert.equal(readingView(used).percent, 75);
});

test("the unrelated spend-limit '0% used' text is not a total", () => {
  const p = parseBalance("0% used");
  assert.notEqual(p.kind, "used-of-total");
});

test("validateDisplay rejects percent without a total and bad totals", () => {
  assert.deepEqual(validateDisplay(bal(), { display: "percent" }), { ok: false, reason: "no-total" });
  assert.equal(validateDisplay(bal(), { total: 0 }).reason, "bad-total");
  assert.equal(validateDisplay(bal(), { total: -5 }).reason, "bad-total");
  assert.equal(validateDisplay(bal(), { total: NaN }).reason, "bad-total");
  assert.equal(validateDisplay(bal(), { display: "wide" }).reason, "bad-display");
  assert.equal(validateDisplay(bal({ total: 200 }), { display: "percent" }).ok, true);
  assert.equal(validateDisplay(bal({ total: 200, display: "percent" }), { total: null }).reason, "no-total");
});

test("Muse: a billing subdomain frame is offered; trackers, other sites and public-suffix lookalikes are not", () => {
  const srcs = [
    "https://dev.meta.ai/api/billing/embed?team_id=1",
    "https://billing.dev.meta.ai/payment_settings/?team_id=1&parent_origin=https%3A%2F%2Fdev.meta.ai",
    "https://x-marketing.fbthirdpartypixel.com/tr/?pixel_key=a",
    "http://billing.dev.meta.ai/insecure",
    "javascript:alert(1)",
  ];
  const f = foreignSameSiteFrames("https://dev.meta.ai/billing?team_id=1", srcs);
  assert.deepEqual(f.map((x) => x.host), ["billing.dev.meta.ai"]);
  assert.deepEqual(foreignSameSiteFrames("chrome://extensions", srcs), []);
  // multi-label public suffix: a sibling under co.uk is not a subdomain of the page host
  assert.deepEqual(foreignSameSiteFrames("https://shop.example.co.uk/", ["https://other.co.uk/x", "https://evil.example.co.uk/x", "https://pay.shop.example.co.uk/x"]).map((x) => x.host), ["pay.shop.example.co.uk"]);
  assert.deepEqual(foreignSameSiteFrames("https://meta.ai/", ["https://meta.ai.evil.com/"]), []);
});

test("the billing frame's text parses as a plain dollar balance", () => {
  const p = parseBalance("$106.20");
  assert.equal(p.ok, true);
  assert.equal(p.value, 106.2);
  assert.equal(p.unit, "$");
});
