export function ebtAnchor(el) {
  const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const ownText = normalize(el.innerText || el.textContent || "");
  let ancestor = el.parentElement;
  for (let i = 0; i < 4 && ancestor; i++) {
    const lines = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const t = normalize(node.textContent);
        if (t) lines.push(t);
      } else if (node.nodeType === 1) {
        for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
      }
    };
    walk(ancestor);
    for (const line of lines) {
      if (line !== ownText && line.length <= 60 && /[a-z]/.test(line) && !/^[\s$€£%0-9.,+\-()kKmM]*$/.test(line)) {
        return line;
      }
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}
