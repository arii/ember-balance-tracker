// Content script: training picker + on-demand reader.
// Injected only after a user gesture (popup action) under activeTab.
// Reads only the visible DOM of this tab: no cookies, no credentials, no storage access.
// Classic script (no static imports): selector.js is loaded by dynamic import
// from web_accessible_resources; balance parsing happens in the service worker.

const HIGHLIGHT_CLASS = "ebt-picker-highlight";
let training = null; // { resolve } while picking

async function loadSelectorLib() {
  const base = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("src/lib/selector.js")
    : window.__ebtSelectorUrl || new URL("../lib/selector.js", import.meta.url).href;
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
  const done = training; training = null;
  done?.resolve({ selector, text, url: location.href, title: document.title });
}

function onKey(e) {
  if (e.key === "Escape") {
    stopTraining();
    const done = training; training = null;
    done?.resolve(null);
    toast("Training cancelled.");
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
        sendResponse(await startTraining());
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
