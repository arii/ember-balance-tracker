import { summarizeTrace } from "../lib/trace.js";

const SETTINGS_KEY = "settings";

async function load() {
  const { settings } = await chrome.storage.local.get(SETTINGS_KEY);
  document.querySelector("#enabled").checked = !!settings?.emberEnabled;
  document.querySelector("#allowPageText").checked = !!settings?.allowPageText;
  document.querySelector("#apiBase").value = settings?.apiBase || "";
  document.querySelector("#apiKey").value = settings?.apiKey || "";

  const { emberTrace } = await chrome.storage.local.get("emberTrace");
  const s = summarizeTrace(emberTrace || []);
  document.querySelector("#trace-summary").textContent = s.calls
    ? `${s.calls} AI calls (${s.failedCalls} failed) · ${s.totalTokens} tokens · ${s.costUsd == null ? "cost unknown (usage missing)" : `≈ $${s.costUsd} of the $10 budget`}`
    : "No AI calls yet.";
}

document.querySelector("#save").addEventListener("click", async () => {
  const settings = {
    emberEnabled: document.querySelector("#enabled").checked,
    allowPageText: document.querySelector("#allowPageText").checked,
    apiBase: document.querySelector("#apiBase").value.trim(),
    apiKey: document.querySelector("#apiKey").value.trim(),
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  document.querySelector("#saved").textContent = "Saved.";
  setTimeout(() => (document.querySelector("#saved").textContent = ""), 2000);
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
