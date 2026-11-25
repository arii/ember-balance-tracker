import { summarizeTrace } from "../lib/trace.js";

const SETTINGS_KEY = "settings";
// Display-only default, matching background.js DEFAULT_MAX_SPEND_USD.
const DEFAULT_MAX_SPEND_USD = 2;

const validCap = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

async function load() {
  const { settings } = await chrome.storage.local.get(SETTINGS_KEY);
  document.querySelector("#enabled").checked = !!settings?.emberEnabled;
  document.querySelector("#allowPageText").checked = !!settings?.allowPageText;
  document.querySelector("#apiBase").value = settings?.apiBase || "";
  document.querySelector("#apiKey").value = settings?.apiKey || "";
  // Never inject the default into the field: if a stored cap turned invalid
  // (corruption, old bug), showing 2 here would let an unrelated save WRITE 2
  // and silently raise what may have been a lower cap. Blank shows "unset or
  // untrustworthy"; the background guard fails closed on an untrustworthy cap.
  document.querySelector("#maxSpend").value = validCap(settings?.maxSpendUsd) ? String(settings.maxSpendUsd) : "";
  const capForDisplay = validCap(settings?.maxSpendUsd) ? settings.maxSpendUsd : DEFAULT_MAX_SPEND_USD;

  const { emberTrace } = await chrome.storage.local.get("emberTrace");
  const s = summarizeTrace(emberTrace || []);
  document.querySelector("#trace-summary").textContent = s.calls
    ? `${s.calls} AI calls (${s.failedCalls} failed) · ${s.totalTokens} tokens · ${s.costUsd == null ? "cost unknown (usage missing)" : `≈ $${s.costUsd.toFixed(6)} of your $${capForDisplay} cap`}`
    : "No AI calls yet.";
}

document.querySelector("#save").addEventListener("click", async () => {
  const { settings: prior = {} } = await chrome.storage.local.get(SETTINGS_KEY);
  const rawCap = document.querySelector("#maxSpend").value.trim();
  const capNum = Number(rawCap);
  const capValid = rawCap !== "" && validCap(capNum);
  const settings = {
    emberEnabled: document.querySelector("#enabled").checked,
    allowPageText: document.querySelector("#allowPageText").checked,
    apiBase: document.querySelector("#apiBase").value.trim(),
    apiKey: document.querySelector("#apiKey").value.trim(),
  };
  const status = document.querySelector("#saved");
  if (capValid) {
    settings.maxSpendUsd = capNum;
    status.textContent = "Saved.";
  } else {
    // Reject the cap change, preserve the prior one: silently writing the
    // default could RAISE a cap the user had set lower. With no prior value,
    // the field stays unset and the guard's built-in default applies.
    if (prior.maxSpendUsd !== undefined) settings.maxSpendUsd = prior.maxSpendUsd;
    status.textContent = "Saved other settings; spend cap unchanged (enter a positive number to change it).";
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  setTimeout(() => (status.textContent = ""), 4000);
});

document.querySelector("#export").addEventListener("click", async () => {
  const { emberTrace } = await chrome.storage.local.get("emberTrace");
  const blob = new Blob([JSON.stringify(emberTrace || [], null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "ember-usage-trace.json";
  a.click();
  URL.revokeObjectURL(a.href);
});

load();
