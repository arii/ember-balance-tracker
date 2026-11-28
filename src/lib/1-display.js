// Pure helpers for how a reading is shown (amount or percent) and for
// spotting same-site frames the extension cannot read. No DOM, no chrome.*.
import { formatValue } from "./format.js";

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * What the last reading says about "left" and "total".
 * A total is only ever one of: the "of N" printed on the page ("0 of 20,000
 * credits used") or a starting amount the user typed. It is never derived from
 * the displayed balance itself.
 */
export function readingView(t) {
  const last = t?.history?.[t.history.length - 1];
  if (!last || typeof last.value !== "number" || !Number.isFinite(last.value)) return null;
  if (last.kind === "used-of-total" && typeof last.total === "number" && last.total > 0) {
    const remaining = last.total - last.value;
    return { remaining, total: last.total, totalSource: "page", unit: last.unit, percent: round1((remaining / last.total) * 100), usedOfTotal: true };
  }
  if (typeof t.total === "number" && Number.isFinite(t.total) && t.total > 0) {
    return { remaining: last.value, total: t.total, totalSource: "you", unit: last.unit, percent: round1((last.value / t.total) * 100), usedOfTotal: false };
  }
  return { remaining: last.value, total: null, totalSource: null, unit: last.unit, percent: null, usedOfTotal: false };
}

/** Text for the row value. Percent mode falls back to the amount when no total exists. */
export function displayValue(t) {
  const v = readingView(t);
  if (!v) return null;
  if (t.display === "percent" && v.percent !== null) return `${v.percent}% left`;
  const amount = formatValue({ value: v.remaining, unit: v.unit });
  return v.usedOfTotal ? `${amount} left` : amount;
}

/** Validate a display change before it is stored. */
export function validateDisplay(t, { display, total }) {
  if (display !== undefined && display !== "amount" && display !== "percent") return { ok: false, reason: "bad-display" };
  if (total !== undefined && total !== null && !(typeof total === "number" && Number.isFinite(total) && total > 0)) return { ok: false, reason: "bad-total" };
  const nextTotal = total === undefined ? t.total : total;
  const nextDisplay = display === undefined ? t.display : display;
  const hasPageTotal = readingView({ ...t, total: null })?.totalSource === "page";
  if (nextDisplay === "percent" && !(typeof nextTotal === "number" && nextTotal > 0) && !hasPageTotal) return { ok: false, reason: "no-total" };
  return { ok: true };
}

/**
 * Frames the page embeds from a subdomain of its own host (dev.meta.ai embeds
 * billing.dev.meta.ai), where activeTab on the page does not reach the frame.
 * Strict on purpose: the frame host must be a subdomain of the page host, so
 * no public-suffix guessing (co.uk) and no unrelated third party qualifies.
 * https only; http only for local test hosts.
 */
export function foreignSameSiteFrames(pageUrl, srcs) {
  let page;
  try { page = new URL(pageUrl); } catch { return []; }
  const localTest = (h) => h === "localhost" || h.endsWith(".localhost") || h.endsWith(".test");
  const allowed = (u) => u.protocol === "https:" || (u.protocol === "http:" && localTest(u.hostname));
  if (!allowed(page)) return [];
  const seen = new Set();
  const out = [];
  for (const s of srcs || []) {
    let u;
    try { u = new URL(s, page.href); } catch { continue; }
    if (!allowed(u) || u.origin === page.origin) continue;
    if (!u.hostname.endsWith("." + page.hostname)) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ url: u.href, host: u.hostname });
  }
  return out;
}
