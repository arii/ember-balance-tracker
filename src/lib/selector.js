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
 * Build a selector for `el`. Prefers a stable #id, otherwise a unique
 * tag:nth-of-type path extended toward the document root as needed. Returns a string that
 * document.querySelector can resolve back to the element.
 */
export function getSelector(el, doc = el.ownerDocument) {
  if (!el || !el.tagName) throw new Error("getSelector: not an element");
  const unique = (selector) => {
    try {
      const matches = doc.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch { return false; }
  };
  const idSelector = (node) => node.id && isStableId(node.id) ? "#" + cssEscapeIdent(node.id) : null;
  const id = idSelector(el);
  if (id && unique(id)) return id;

  for (const attr of el.attributes || []) {
    if (/^data-(testid|test|qa|cy|balance|amount|value)$/.test(attr.name)) {
      const value = attr.value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ").replace(/\r/g, "\\d ").replace(/\f/g, "\\c ");
      const candidate = `${el.tagName.toLowerCase()}[${attr.name}="${value}"]`;
      if (unique(candidate)) return candidate;
    }
  }

  // A five-level suffix can collide across dashboard cards. Extend toward
  // the document root until this path identifies exactly the picked node.
  const parts = [];
  for (let cur = el; cur && cur.tagName; cur = cur.parentElement) {
    parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${nthOfType(cur)})`);
    const ancestorId = idSelector(cur);
    if (ancestorId) {
      const anchored = [ancestorId, ...parts.slice(1)].join(" > ");
      if (unique(anchored)) return anchored;
    }
    const candidate = parts.join(" > ");
    if (unique(candidate)) return candidate;
  }
  throw new Error("getSelector: element is not uniquely selectable in document");
}
