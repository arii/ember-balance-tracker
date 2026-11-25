// Options page tested against the real options.js with stubbed document and
// chrome.storage: load rendering, save persistence, and the fail-closed cap
// rules (an invalid/blank cap field must never overwrite a stored cap with
// the default, which could RAISE a cap the user set lower).
import { test } from "node:test";
import assert from "node:assert/strict";

function makeDom() {
  const els = {};
  const handlers = {};
  const mk = (id) => (els[id] ??= {
    id, value: "", checked: false, textContent: "",
    addEventListener: (ev, fn) => { handlers[`${id}:${ev}`] = fn; },
  });
  return {
    els, handlers,
    document: {
      querySelector: (sel) => mk(sel.replace(/^#/, "")),
      createElement: () => ({ click() {}, href: "", download: "" }),
    },
  };
}

async function importOptions(store = {}) {
  const dom = makeDom();
  globalThis.document = dom.document;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: store[key] }; },
        async set(obj) { Object.assign(store, obj); },
      },
    },
  };
  // Keep the module's status-clear timer from holding the test process open.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try {
    await import(`../src/options/options.js?case=${Math.random()}`);
    await new Promise((r) => realSetTimeout(r, 0)); // let load()'s awaits settle
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  return { ...dom, store };
}

test("load shows a valid stored cap", async () => {
  const { els } = await importOptions({ settings: { maxSpendUsd: 0.5, apiKey: "k" } });
  assert.equal(els.maxSpend.value, "0.5");
  assert.equal(els.apiKey.value, "k");
});

test("load leaves the field blank on an invalid stored cap instead of injecting the default", async () => {
  for (const bad of [-3, 0, "junk", NaN]) {
    const { els } = await importOptions({ settings: { maxSpendUsd: bad } });
    assert.equal(els.maxSpend.value, "", `stored ${String(bad)} must not surface as a writable default`);
  }
});

test("load leaves the field blank when no cap was ever set", async () => {
  const { els } = await importOptions({});
  assert.equal(els.maxSpend.value, "");
});

test("save persists a valid cap as a number", async () => {
  const { els, handlers, store } = await importOptions({ settings: { maxSpendUsd: 2 } });
  els.maxSpend.value = "1.25";
  els.apiKey.value = "  sk-test  ";
  await handlers["save:click"]();
  assert.equal(store.settings.maxSpendUsd, 1.25);
  assert.equal(store.settings.apiKey, "sk-test");
  assert.equal(els.saved.textContent, "Saved.");
});

test("save with an invalid cap preserves the prior stored cap and warns", async () => {
  for (const bad of ["junk", "-5", "0"]) {
    const { els, handlers, store } = await importOptions({ settings: { maxSpendUsd: 0.5, apiKey: "old" } });
    els.maxSpend.value = bad;
    els.apiKey.value = "new";
    await handlers["save:click"]();
    assert.equal(store.settings.maxSpendUsd, 0.5, `input ${JSON.stringify(bad)} must not overwrite the stored cap`);
    assert.equal(store.settings.apiKey, "new", "other settings still save");
    assert.match(els.saved.textContent, /cap unchanged/);
  }
});

test("save with a blank cap and no prior cap stores no cap key (guard default applies)", async () => {
  const { els, handlers, store } = await importOptions({});
  els.maxSpend.value = "";
  await handlers["save:click"]();
  assert.equal("maxSpendUsd" in store.settings, false);
  assert.match(els.saved.textContent, /cap unchanged/);
});

test("trace summary rounds only for display", async () => {
  const { els } = await importOptions({
    settings: { maxSpendUsd: 2 },
    emberTrace: [
      { ok: true, usageKnown: true, costUsd: 1.0000004, promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      { ok: true, usageKnown: true, costUsd: 1.0000004, promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    ],
  });
  assert.match(els["trace-summary"].textContent, /\$2\.000001 of your \$2 cap/);
});
