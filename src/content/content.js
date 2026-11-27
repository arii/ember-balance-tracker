// Content script: training picker + on-demand reader.
// Injected only after a user gesture (popup action) under activeTab.
// Reads only the visible DOM of this tab: no cookies, no credentials, no storage access.
// Classic script (no static imports, no import.meta): selector.js is loaded by dynamic import
// from web_accessible_resources; balance parsing happens in the service worker.
if (!globalThis.__ebtContentInstalled) {
globalThis.__ebtContentInstalled = true;
const EBT_CONTENT_BUILD = "2026-11-26-d";
const HIGHLIGHT_CLASS = "ebt-picker-highlight";

function ebtAnchor(el) {
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
let training = null; // { resolve } while picking

async function loadSelectorLib() {
  const base = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("src/lib/selector.js")
    : window.__ebtSelectorUrl || new URL("../lib/selector.js", location.href).href;
  const mod = await import(base);
  return mod.getSelector;
}

function ensureStyles() {
  if (document.getElementById("ebt-styles")) return;
  const style = document.createElement("style");
  style.id = "ebt-styles";
  style.textContent = `
    .${HIGHLIGHT_CLASS} { outline: 3px solid #f59e0b !important; outline-offset: 2px !important; cursor: crosshair !important; }
    #ebt-toast { position: fixed; bottom: 16px; right: 16px; z-index: 2147483647; background: #111827; color: #f9fafb;
      padding: 10px 14px; border-radius: 8px; font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.35); max-width: 320px; }
  `;
  document.documentElement.appendChild(style);
}

function toast(msg, ms = 3500) {
  ensureStyles();
  document.getElementById("ebt-toast")?.remove();
  const el = document.createElement("div");
  el.id = "ebt-toast";
  el.textContent = msg;
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function onHover(e) {
  document.querySelectorAll("." + HIGHLIGHT_CLASS).forEach((n) => n.classList.remove(HIGHLIGHT_CLASS));
  e.target.classList?.add(HIGHLIGHT_CLASS);
}

function stopTraining() {
  document.removeEventListener("mouseover", onHover, true);
  document.removeEventListener("click", onPick, true);
  document.removeEventListener("keydown", onKey, true);
  document.querySelectorAll("." + HIGHLIGHT_CLASS).forEach((n) => n.classList.remove(HIGHLIGHT_CLASS));
}

async function onPick(e) {
  e.preventDefault();
  e.stopPropagation();
  const el = e.target;
  stopTraining();
  const getSelector = await loadSelectorLib();
  const selector = getSelector(el);
  const text = (el.innerText || el.textContent || "").trim();
  const anchor = ebtAnchor(el);
  const done = training; training = null;
  done?.resolve({ selector, anchor, text, url: location.href, title: document.title });
}

function cancelTraining() {
  if (!training) return false;
  stopTraining();
  const done = training; training = null;
  done?.resolve(null);
  return true;
}

function onKey(e) {
  if (e.key === "Escape") {
    if (cancelTraining()) toast("Training cancelled.");
  }
}

function startTraining() {
  return new Promise((resolve) => {
    training = { resolve };
    ensureStyles();
    document.addEventListener("mouseover", onHover, true);
    document.addEventListener("click", onPick, true);
    document.addEventListener("keydown", onKey, true);
    toast("Click the number that shows the balance. Esc to cancel.");
  });
}

function readAt(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: "selector-not-found", selector };
  const text = (el.innerText || el.textContent || "").trim();
  if (!text) return { ok: false, reason: "empty", selector };
  return { ok: true, selector, text };
}

function pageTextSample(maxChars = 4000) {
  const t = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return t.slice(0, maxChars);
}

// In a plain page (demo/E2E), chrome.runtime is absent: expose the same flows
// on window.__ebt so demo/index.html and tests can drive them directly.
if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) {
  window.__ebt = { startTraining, readAt, pageTextSample };
} else {
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "ebt:start-training":
        // The background broadcasts this to every frame (balances often
        // live in iframes) and does not await the pick: each frame reports
        // back separately, which also survives a service worker restart
        // while the user aims.
        sendResponse({ ok: true, armed: true });
        startTraining().then((picked) => {
          if (picked) {
            toast("Balance picked — saving…", 2000);
            chrome.runtime.sendMessage({ type: "ebt:picked", picked })
        .then((r) => {
          if (!r?.ok) {
            if (r?.reason === "unknown-message") {
              toast("Ember is out of date: open chrome://extensions, click reload on Ember, then refresh this page and try again.", 6000);
            } else {
              toast("Training failed to save: " + (r?.reason || "no response"), 6000);
            }
          }
        })
        .catch((e) => toast("Training failed to save: " + String(e?.message || e), 6000));
          } else {
            chrome.runtime.sendMessage({ type: "ebt:pick-cancelled" }).catch(() => {});
          }
        });
        break;
      case "ebt:cancel-training":
        cancelTraining();
        sendResponse({ ok: true });
        break;
      case "ebt:read":
        sendResponse(readAt(msg.selector));
        break;
      case "ebt:page-text":
        sendResponse({ ok: true, text: pageTextSample(msg.maxChars) });
        break;
      case "ebt:trained":
        toast(`Now tracking \"${msg.label}\".` + (msg.pattern ? " Learned an extraction rule." : ""));
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, reason: "unknown-message" });
    }
  })();
  return true; // async sendResponse
});
}

} // __ebtContentInstalled
