// Pure balance-text parsing. No DOM, no chrome.* — unit-testable in Node.

const UNIT_WORDS = [
  "credits", "credit", "points", "point", "tokens", "token",
  "CR", "cr", "hrs", "hours", "minutes", "GB", "MB", "%",
];

// Number capture shared by every branch: digits with any mix of "." and ","
// separators. normalizeNumber below decides which separator convention a
// captured token actually uses.
const NUMBER = "([\\d.,]+)";

function normalizeNumber(raw) {
  const cleaned = String(raw).trim().replace(/^[.,\s]+|[.,\s]+$/g, "");
  if (!cleaned) return null;
  // Decimal-comma with dot thousands: "12.890,50" / "1.234.567,89" (pt-BR, EU).
  let m = cleaned.match(/^(\d{1,3}(?:\.\d{3})+),(\d{1,2})$/);
  if (m) return Number(m[1].replace(/\./g, "") + "." + m[2]);
  // Decimal-comma without thousands: "1234,56". A comma followed by 1-2
  // trailing digits is not valid US grouping (which needs exactly three), so
  // reading it as a decimal comma does not steal any valid US number.
  m = cleaned.match(/^(\d+),(\d{1,2})$/);
  if (m) return Number(m[1] + "." + m[2]);
  // US/UK: "1,234.50" -> 1234.5 ; "0.05" -> 0.05
  const n = Number(cleaned.replace(/,/g, ""));
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
  const usedOf = raw.match(new RegExp(NUMBER + "\\s*(?:of|\\/)\\s*" + NUMBER + "\\s*([A-Za-z%]+)?", "i"));
  if (usedOf) {
    const used = normalizeNumber(usedOf[1]);
    const total = normalizeNumber(usedOf[2]);
    if (used !== null && total !== null && total > 0) {
      return { ok: true, value: used, total, unit: usedOf[3] || null, raw, kind: "used-of-total" };
    }
  }

  // "$100.05" / "-$5.20" (overdrawn) / "€11" / "USD 44.99" / "R$ 12.890,50".
  // The minus must sit directly before the currency marker: the "-" in
  // "Balance - $5.20" is punctuation, not a sign.
  const currency = raw.match(/(-)?(?:R?[$€£]\s?|USD\s)([\d.,]+)/);
  if (currency) {
    const value = normalizeNumber(currency[2]);
    if (value !== null) return { ok: true, value: currency[1] ? -value : value, unit: "$", raw, kind: "currency" };
  }

  // "4,000 credits" / "127 CR" / "10 points" (number first, unit word after).
  // No sign here: in "Range 5-10 credits" the hyphen is a range separator.
  const unitAfter = raw.match(new RegExp(NUMBER + "\\s*(credits?|points?|tokens?|CR|cr|hrs?|hours?|minutes?|GB|MB|%)\\b"));
  if (unitAfter) {
    const value = normalizeNumber(unitAfter[1]);
    if (value !== null) return { ok: true, value, unit: unitAfter[2], raw, kind: "unit" };
  }

  // "Balance: 100.05" / "Balance: -100" bare number last resort. A leading
  // minus counts only when it is not part of a hyphenated token: the "-" in
  // "AC-8812" is inside an identifier, so the number stays positive.
  const bare = raw.match(new RegExp("(?<![\\w$€£])(-)?" + NUMBER));
  if (bare) {
    const value = normalizeNumber(bare[2]);
    if (value !== null) return { ok: true, value: bare[1] ? -value : value, unit: null, raw, kind: "bare" };
  }

  return { ok: false, value: null, unit: null, raw, kind: null };
}

export { UNIT_WORDS };
