// Pure formatting helpers for the popup. No DOM, no chrome.* — unit-testable in Node.

/**
 * Format a reading value for display.
 * @param {Object|null|undefined} last - The last reading object { value, unit, ts, source }.
 * @returns {string} e.g. "$6.90", "69%", "1,500 credits", or "No reading yet".
 */
export function formatValue(last) {
  if (!last || typeof last.value !== 'number' || !Number.isFinite(last.value)) {
    return 'No reading yet';
  }
  const value = last.value;
  const unit = last.unit;

  // Determine number formatting options per unit.
  let opts;
  if (unit === '$') {
    opts = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  } else {
    opts = { maximumFractionDigits: 2 };
  }

  // Get the raw number string, e.g. "-5.20" or "-0.00" or "1,500".
  let numStr = value.toLocaleString('en-US', opts);

  // Remove a leading minus when the displayed rounded value is zero.
  // Works for "-0", "-0.00", "-0.00", etc.
  if (numStr.startsWith('-') && Number.parseFloat(numStr) === 0) {
    numStr = numStr.slice(1);
  }

  if (unit === '$') {
    // Currency: sign goes before the currency symbol, and always 2 decimals.
    if (numStr.startsWith('-')) {
      return `-$${numStr.slice(1)}`;
    }
    return `$${numStr}`;
  }
  if (unit === '%') {
    return `${numStr}%`;
  }
  if (unit) {
    return `${numStr} ${unit}`;
  }
  return numStr;
}

/**
 * Relative time string from a timestamp.
 * @param {number|string|Date} ts - Timestamp (ms since epoch).
 * @param {number} now - Current time in ms (default Date.now()).
 * @returns {string} "just now", "N min ago", "N h ago", or a date string.
 */
export function relativeTime(ts, now = Date.now()) {
  const time = new Date(ts).getTime();
  if (Number.isNaN(time)) return '';
  const diff = now - time;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(time).toLocaleDateString();
}

/**
 * True if the tracker has a last failure newer than its last successful read.
 * @param {Object} t - Tracker object.
 * @returns {boolean}
 */
export function isStale(t) {
  const last = t.history?.[t.history.length - 1];
  return Boolean(t.lastFailure && last && t.lastFailure.ts > last.ts);
}

/**
 * True if the tracker has at least one history entry and no anchor.
 * @param {Object} t - Tracker object.
 * @returns {boolean}
 */
export function isUnverified(t) {
  const last = t.history?.[t.history.length - 1];
  return Boolean(last && !t.anchor);
}

/**
 * @param {object} t - tracker object.
 * @returns {"empty"|"stale"|"unverified"|"ok"}
 */
export function rowState(t) {
  if (!t.history || t.history.length === 0) return "empty";
  if (isStale(t)) return "stale";
  if (isUnverified(t)) return "unverified";
  return "ok";
}

/**
 * Short meta line for a tracker row: relative time only.
 * @param {Object} t - Tracker object.
 * @returns {string} e.g. "5 min ago" or "never read".
 */
export function formatMeta(t, now = Date.now()) {
  const last = t.history?.[t.history.length - 1];
  if (!last) return 'never read';
  if (isStale(t)) return `Out of date: last good read ${relativeTime(last.ts, now)}, latest check failed. Click Refresh to try again.`;
  let result = relativeTime(last.ts, now);
  if (now - new Date(last.ts).getTime() > 5 * 60_000) result += ' - may be out of date';
  if (isUnverified(t)) result += ' - unverified';
  return result;
}

/**
 * Multi-line tooltip for a tracker row.
 * @param {Object} t - Tracker object.
 * @returns {string} Tooltip text with url, source, absolute time, rule status.
 */
export function titleFor(t) {
  const last = t.history?.[t.history.length - 1];
  const lines = [];
  if (t.urlPattern) lines.push(`URL: ${t.urlPattern}`);
  if (last) {
    if (last.source) lines.push(`Source: ${last.source}`);
    lines.push(`Last read: ${new Date(last.ts).toLocaleString()}`);
  } else {
    lines.push('No reading yet');
  }
  if (t.pattern) {
    lines.push('Ember rule: ✓');
  } else if (t.emberStatus && !t.emberStatus.ok) {
    lines.push(`Ember: no rule learned (${t.emberStatus.reason})`);
  } else {
    lines.push('Ember: off');
  }
  if (isStale(t)) lines.push(`Last read failed: ${t.lastFailure.reason}`);
  if (isUnverified(t)) lines.push('Unverified: no label saved, retrain to enable checks');
  return lines.join('\n');
}
