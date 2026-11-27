import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createMockMetaServer } from "../demo/mock-meta.mjs";

const TRACKERS_KEY = "trackers";
const SETTINGS_KEY = "settings";

let listener;
let sendMessageCalls;
let injectCalls;
let sessionThrows = false;
let sessionValue = null;
let storageData = {};
let idCounter = 0;


globalThis.chrome = {
  runtime: { onMessage: { addListener(fn) { listener = fn; } } },
  storage: {
    local: {
      async get(keys) {
        await new Promise((r) => setTimeout(r, 5));
        if (keys === null) return { ...storageData };
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) if (k in storageData) out[k] = storageData[k];
          return out;
        }
        return { [keys]: storageData[keys] };
      },
      async set(obj) {
        await new Promise((r) => setTimeout(r, 5));
        Object.assign(storageData, obj);
      },
    },
    session: {
      async get() { if (sessionThrows) throw new Error("session gone"); return { pendingTraining: sessionValue }; },
      async set(v) { sessionValue = v.pendingTraining; },
      async remove() {},
    },
  },
  scripting: {
    async executeScript({ func, target }) {
      if (func) return [{ frameId: 0, result: "http://x/" }];
      injectCalls.push(target?.frameIds ?? null);
      return [{}];
    },
  },
  tabs: {
    async sendMessage(tabId, msg, { frameId } = {}) {
      sendMessageCalls.push({ type: msg.type, frameId });
      if (msg.type === "ebt:read") {
        return { ok: true, text: "x" };
      }
      if (msg.type === "ebt:start-training") return { ok: true, armed: true };
      return { ok: true };
    },
  },
};

function sendMessage(msg) {
  return new Promise((resolve) => {
    listener(msg, {}, resolve);
  });
}

async function loadBackground() {
  await import("../src/background.js");
}

test.before(async () => {
  await loadBackground();
});

test.beforeEach(() => {
  storageData = {};
  sessionValue = null;
  sendMessageCalls = [];
  injectCalls = [];
  idCounter = 0;
});

test("two concurrent add-tracker both persist", async () => {
  const p1 = sendMessage({ type: "ebt:add-tracker", label: "one", selector: "sel1", url: "https://a.com", anchor: null });
  const p2 = sendMessage({ type: "ebt:add-tracker", label: "two", selector: "sel2", url: "https://b.com", anchor: null });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  const trackers = storageData[TRACKERS_KEY] || [];
  assert.equal(trackers.length, 2);
  assert.ok(trackers.some(t => t.label === "one"));
  assert.ok(trackers.some(t => t.label === "two"));
});

test("delete racing add: new persists and deleted is gone", async () => {
  const added = await sendMessage({ type: "ebt:add-tracker", label: "old", selector: "sel", url: "https://old.com", anchor: null });
  assert.equal(added.ok, true);
  const oldId = storageData[TRACKERS_KEY][0].id;

  const delPromise = sendMessage({ type: "ebt:delete-tracker", id: oldId });
  const addPromise = sendMessage({ type: "ebt:add-tracker", label: "new", selector: "newsel", url: "https://new.com", anchor: null });
  const [delResp, addResp] = await Promise.all([delPromise, addPromise]);
  assert.equal(delResp.ok, true);
  assert.equal(addResp.ok, true);
  const trackers = storageData[TRACKERS_KEY] || [];
  assert.equal(trackers.length, 1);
  assert.equal(trackers[0].label, "new");
  assert.ok(!trackers.some(t => t.id === oldId));
});

test("10 concurrent adds all persist", async () => {
  const promises = Array.from({ length: 10 }, (_, i) =>
    sendMessage({ type: "ebt:add-tracker", label: `t${i}`, selector: `s${i}`, url: `https://x${i}.com`, anchor: null })
  );
  const results = await Promise.all(promises);
  assert.ok(results.every(r => r.ok === true));
  const trackers = storageData[TRACKERS_KEY] || [];
  assert.equal(trackers.length, 10);
  const labels = new Set(trackers.map(t => t.label));
  assert.equal(labels.size, 10);
});

test("derivePattern race with add-tracker preserves both and sets pattern", async (t) => {
  const mock = createMockMetaServer({ deriveSequence: ["valid"] });
  const apiBase = await mock.listen();
  t.after(() => mock.close());
  storageData[SETTINGS_KEY] = { emberEnabled: true, apiKey: "k", apiBase, maxSpendUsd: 1 };

  const firstAddResp = await sendMessage({ type: "ebt:add-tracker", label: "first", selector: "sel1", url: "https://first.com", anchor: null });
  assert.equal(firstAddResp.ok, true);
  const firstId = storageData[TRACKERS_KEY][0].id;

  const derivePromise = sendMessage({ type: "ebt:derive-pattern", id: firstId, trainingText: "$100.05" });
  const addPromise = sendMessage({ type: "ebt:add-tracker", label: "second", selector: "sel2", url: "https://second.com", anchor: null });

  const [deriveResp, addResp] = await Promise.all([derivePromise, addPromise]);
  assert.equal(deriveResp.ok, true);
  assert.ok(deriveResp.pattern);
  assert.equal(addResp.ok, true);

  const trackers = storageData[TRACKERS_KEY] || [];
  assert.equal(trackers.length, 2);
  const first = trackers.find(t => t.id === firstId);
  const second = trackers.find(t => t.label === "second");
  assert.ok(first, "first tracker exists");
  assert.ok(second, "second tracker exists");
  assert.ok(first.pattern);
  assert.equal(first.pattern, deriveResp.pattern);
});
