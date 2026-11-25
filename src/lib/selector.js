// Robust-ish CSS selector generation for a clicked element.
// Pure function of a DOM element; works in the page and under jsdom.

function cssEscapeIdent(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}

function nthOfType(el) {
  let i = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) i++;
    sib = sib.previousElementSibling;
  }
  return i;
}

function isStableId(id) {
  // Reject auto-generated-looking ids (long digit runs, uuid-ish).
  return /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(id) && !/\d{6,}/.test(id);
}

/**
 * Build a selector for `el`. Prefers a stable #id, otherwise a short
 * tag:nth-of-type path (max depth 5). Returns a string that
 * document.querySelector can resolve back to the element.
 */
export function getSelector(el, doc = el.ownerDocument) {
  if (!el || !el.tagName) throw new Error("getSelector: not an element");
  if (el.id && isStableId(el.id)) return "#" + cssEscapeIdent(el.id);

  // Useful data attributes make resilient anchors.
  for (const attr of el.attributes || []) {
    if (/^data-(testid|test|qa|cy|balance|amount|value)$/.test(attr.name)) {
      return `${el.tagName.toLowerCase()}[${attr.name}="${attr.value.replace(/"/g, '\\"')}"]`;
    }
  }

  const parts = [];
  let cur = el;
  let depth = 0;
  while (cur && cur.tagName && cur.tagName.toLowerCase() !== "html" && depth < 5) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && isStableId(cur.id)) {
      parts.unshift("#" + cssEscapeIdent(cur.id) + " > " + part);
      break;
    }
    part += `:nth-of-type(${nthOfType(cur)})`;
    parts.unshift(part);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join(" > ");
}
