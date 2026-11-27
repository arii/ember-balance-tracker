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
  const trimmed = String(raw).trim();
  const dotOnly = trimmed.match(/^\.(\d+)$/);
  if (dotOnly) return Number("0." + dotOnly[1]);
  const cleaned = trimmed.replace(/^[.,\s]+|[.,\s]+$/g, "");
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
  const res = parseCore(raw);
  if (!res.ok || typeof res.value !== "number") return res;
  // Accounting negative: "($5.20)" / "Balance: (1,234.56)". Only when the
  // parenthesised number is the sole number in the text, so a trailing
  // "(min $50.00)" aside never flips the sign. With a currency marker inside
  // the parentheses that is enough; a bare number needs a decimal or grouping
  // separator and no letters after it, so "Credits (5) remaining" and
  // "Total (1,234.56) USD" are left alone.
  if (res.kind !== "used-of-total" && res.value > 0) {
    const m = raw.match(/^[^\d()]*\(\s*((?:R?[$€£]\s?|USD\s)?)(\d[\d.,'’]*)\s*\)([^\d]*)$/);
    if (m && (m[1] || (/[.,]/.test(m[2]) && !/[A-Za-z]/.test(m[3])))) return { ...res, value: -res.value };
  }
  return res;
}

// Expand "12K" / "1.5M" (suffix glued to the digits) and drop Swiss-style
// apostrophe grouping ("1'234.56") before the branches run. "12 MB" has a
// space and a trailing letter, so it never matches the suffix rule.
function prepare(raw) {
  return raw
    .replace(/−/g, "-")
    .replace(/([$€£])\s?-(?=\d)/g, "-$1")
    .replace(/(\d)['’](?=\d{3}(?!\d))/g, "$1")
    .replace(/(?<![0-9.,])(\d{1,3}(?: \d{3})+)(?=(?:\D|$)|\.\d{1,2}(?!\d))/g, (all, num) => num.replace(/ /g, ""))
    .replace(/(\d[\d.,]*)([kKM])(?![A-Za-z\d])/g, (all, num, suf) => {
      const n = normalizeNumber(num);
      if (n === null) return all;
      return String(Number((n * (suf.toLowerCase() === "k" ? 1e3 : 1e6)).toFixed(2)));
    });
}

function parseCore(rawIn) {
  const raw0 = rawIn;
  const raw = prepare(rawIn);

  // "0 of 20,000 credits used" / "500 / 2000 credits"
  const usedOfPattern = NUMBER + "\\s*(?:of|\\/)\\s*" + NUMBER + "\\s*([A-Za-z%]+)?";
  const usedOfMatches = [...raw.matchAll(new RegExp(usedOfPattern, "gi"))];
  if (usedOfMatches.length) {
    for (const m of usedOfMatches) {
      const used = normalizeNumber(m[1]);
      const total = normalizeNumber(m[2]);
      if (used === null || total === null || total <= 0) continue;
      const yearFirst = m[0].includes("/") && /^(19|20)\d{2}$/.test(m[1]) && /^\d{1,2}$/.test(m[2]) && Number(m[2]) <= 12;
      const mdLike = m[0].includes("/") &&
        /^\d{1,2}$/.test(m[1]) && /^\d{1,2}$/.test(m[2]) &&
        Number(m[1]) <= 12 && Number(m[2]) <= 31 &&
        (/^\/\d/.test(raw.slice(m.index + m[0].length)) || (!m[3] && raw.trim() !== m[0].trim()) ||
          (m[3] && !/^(credits?|tokens?|requests?|calls?|messages?|minutes?|mins?|hours?|gb|mb|tb|kb|%|used|left|remaining|units?|queries|searches|images?|seats?|points?|pts|days?)$/i.test(m[3])));
      const dateLike = yearFirst || mdLike;
      if (!dateLike) {
        return { ok: true, value: used, total, unit: m[3] || null, raw: raw0, kind: "used-of-total" };
      }
    }
  }

  // "$100.05" / "-$5.20" (overdrawn) / "€11" / "USD 44.99" / "R$ 12.890,50".
  // The minus must sit directly before the currency marker: the "-" in
  // "Balance - $5.20" is punctuation, not a sign.
  const currency = raw.match(/(-)?(?:R?[$€£]\s?|USD\s)([\d.,]+)/);
  if (currency) {
    const value = normalizeNumber(currency[2]);
    if (value !== null) return { ok: true, value: currency[1] ? -value : value, unit: "$", raw: raw0, kind: "currency" };
  }

  // "4,000 credits" / "127 CR" / "10 points" (number first, unit word after).
  // No sign here: in "Range 5-10 credits" the hyphen is a range separator.
  const unitAfter = raw.match(new RegExp("(?:(?<![\\w$€£.,#])(?<!\\d\\s)(-))?([\\d.,]+)\\s*(credits?|points?|tokens?|CR|cr|hrs?|hours?|minutes?|GB|MB|%)(?![A-Za-z])"));
  if (unitAfter) {
    const value = normalizeNumber(unitAfter[2]);
    if (value !== null) return { ok: true, value: unitAfter[1] ? -value : value, unit: unitAfter[3], raw: raw0, kind: "unit" };
  }

  // "Balance: 100.05" / "Balance: -100" bare number last resort. A leading
  // minus counts only when it is not part of a hyphenated token: the "-" in
  // "AC-8812" is inside an identifier, so the number stays positive.
  const bare = raw.match(new RegExp("(?<![\\w$€£])(-)?" + NUMBER));
  if (bare) {
    const value = normalizeNumber(bare[2]);
    if (value !== null) return { ok: true, value: bare[1] ? -value : value, unit: null, raw: raw0, kind: "bare" };
  }

  return { ok: false, value: null, unit: null, raw: raw0, kind: null };
}

export { UNIT_WORDS };
