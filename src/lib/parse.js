// Pure balance-text parsing. No DOM, no chrome.* — unit-testable in Node.

const UNIT_WORDS = [
  "credits", "credit", "points", "point", "tokens", "token",
  "CR", "cr", "hrs", "hours", "minutes", "GB", "MB", "%",
];

function normalizeNumber(raw) {
  // "1,234.50" -> 1234.5 ; "0.05" -> 0.05
  const cleaned = raw.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a short text snippet into a balance reading.
 * Returns { ok, value, unit, raw, kind } where kind is one of
 * "currency" | "unit" | "used-of-total" | null.
 */
export function parseBalance(text) {
  if (typeof text !== "string") return { ok: false, value: null, unit: null, raw: text, kind: null };
  const raw = text.trim().replace(/\s+/g, " ");
  if (!raw) return { ok: false, value: null, unit: null, raw, kind: null };

  // "0 of 20,000 credits used" / "500 / 2000 credits"
  const usedOf = raw.match(/([\d,]+(?:\.\d+)?)\s*(?:of|\/)\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z%]+)?/i);
  if (usedOf) {
    const used = normalizeNumber(usedOf[1]);
    const total = normalizeNumber(usedOf[2]);
    if (used !== null && total !== null && total > 0) {
      return { ok: true, value: used, total, unit: usedOf[3] || null, raw, kind: "used-of-total" };
    }
  }

  // "$100.05" / "€11" / "USD 44.99"
  const currency = raw.match(/(?:[$€£]\s?|USD\s)([\d,]+(?:\.\d+)?)/);
  if (currency) {
    const value = normalizeNumber(currency[1]);
    if (value !== null) return { ok: true, value, unit: "$", raw, kind: "currency" };
  }

  // "4,000 credits" / "127 CR" / "10 points" (number first, unit word after)
  const unitAfter = raw.match(/([\d,]+(?:\.\d+)?)\s*(credits?|points?|tokens?|CR|cr|hrs?|hours?|minutes?|GB|MB|%)\b/);
  if (unitAfter) {
    const value = normalizeNumber(unitAfter[1]);
    if (value !== null) return { ok: true, value, unit: unitAfter[2], raw, kind: "unit" };
  }

  // "Balance: 100.05" bare number last resort
  const bare = raw.match(/([\d,]+(?:\.\d+)?)/);
  if (bare) {
    const value = normalizeNumber(bare[1]);
    if (value !== null) return { ok: true, value, unit: null, raw, kind: "bare" };
  }

  return { ok: false, value: null, unit: null, raw, kind: null };
}

export { UNIT_WORDS };
