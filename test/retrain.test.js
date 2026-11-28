import { test } from "node:test";
import assert from "node:assert/strict";

const TRACKERS_KEY = "trackers";
let listener;
let localData;
let sessionData;

function reset() {
  localData = {};
  sessionData = {};
  global.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
    storage: {
      local: {
        get: async (key) => ({ [key]: localData[key] }),
        set: async (obj) => Object.assign(localData, obj),
      },
      session: {
        get: async (key) => ({ [key]: sessionData[key] }),
        set: async (obj) => Object.assign(sessionData, obj),
        remove: async (key) => {
          if (Array.isArray(key)) {
            key.forEach((k) => delete sessionData[k]);
          } else {
            delete sessionData[key];
          }
        },
      },
    },
    tabs: {
      sendMessage: async () => ({ ok: true }),
      query: async () => [{ id: 1, url: "https://example.com" }],
    },
    scripting: {
      executeScript: async () => [{ frameId: 0, result: "https://example.com" }],
    },
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0 }],
    },
  };
}

reset();
await import("../src/background.js");

function callListener(msg, sender = { tab: { id: 1 } }) {
  return new Promise((resolve) => {
    listener(msg, sender, (response) => resolve(response));
  });
}

test("retains legacy tracker in place", async () => {
  localData = {};
  sessionData = {};
  const initialHistory = [
    { value: 1, unit: "USD", raw: "$1", source: "training", ts: 1 },
    { value: 2, unit: "USD", raw: "$2", source: "training", ts: 2 },
    { value: 3, unit: "USD", raw: "$3", source: "training", ts: 3 },
  ];
  localData[TRACKERS_KEY] = [
    {
      id: "t1",
      label: "Test",
      urlPattern: "https://example.com",
      selector: "old",
      anchor: null,
      lastFailure: { msg: "x", ts: 1 },
      history: structuredClone(initialHistory),
    },
  ];

  const armRes = await callListener({ type: "ebt:arm-training", tabId: 1, label: "Test", trackerId: "t1" });
  assert.equal(armRes.ok, true);

  const pickRes = await callListener({
    type: "ebt:picked",
    picked: { url: "https://example.com/page", selector: "new", text: "42", anchor: "balance" },
  });
  assert.equal(pickRes.ok, true);
  assert.equal(pickRes.trackerId, "t1");

  const trackers = localData[TRACKERS_KEY];
  assert.equal(trackers.length, 1);
  const t = trackers[0];
  assert.equal(t.id, "t1");
  assert.equal(t.anchor, "balance");
  assert.equal(t.selector, "new");
  assert.equal(t.selector, "new");
  assert.equal(t.history.length, 4);
  assert.deepEqual(t.history.slice(0, 3), initialHistory);
  assert.equal(t.lastFailure, undefined);
});

test("retrain rejects origin mismatch without modifying tracker", async () => {
  localData = {};
  sessionData = {};
  localData[TRACKERS_KEY] = [
    {
      id: "t1",
      label: "Test",
      urlPattern: "https://example.com",
      selector: "old",
      anchor: null,
      history: [{ value: 1, unit: "USD", raw: "$1", source: "training", ts: 1 }],
    },
  ];

  const armRes = await callListener({ type: "ebt:arm-training", tabId: 1, label: "Test", trackerId: "t1" });
  assert.equal(armRes.ok, true);

  const pickRes = await callListener({
    type: "ebt:picked",
    picked: { url: "https://other.com/page", selector: "new", text: "42", anchor: "balance" },
  });
  assert.equal(pickRes.ok, false);
  assert.equal(pickRes.reason, "origin-mismatch");

  const trackers = localData[TRACKERS_KEY];
  assert.equal(trackers.length, 1);
  const t = trackers[0];
  assert.equal(t.selector, "old");
  assert.equal(t.anchor, null);
});

test("retrains only the targeted tracker when same label exists on another origin", async () => {
  localData = {};
  sessionData = {};
  const t1 = {
    id: "t1",
    label: "Same",
    urlPattern: "https://example.com",
    selector: "old1",
    anchor: null,
    history: [{ value: 1, unit: "USD", raw: "$1", source: "training", ts: 1 }],
  };
  const t2 = {
    id: "t2",
    label: "Same",
    urlPattern: "https://other.com",
    selector: "old2",
    anchor: null,
    history: [{ value: 2, unit: "USD", raw: "$2", source: "training", ts: 1 }],
  };
  localData[TRACKERS_KEY] = [t1, t2];

  const armRes = await callListener({ type: "ebt:arm-training", tabId: 1, label: "Same", trackerId: "t1" });
  assert.equal(armRes.ok, true);

  const pickRes = await callListener({
    type: "ebt:picked",
    picked: { url: "https://example.com/page", selector: "new1", text: "42", anchor: "balance" },
  });
  assert.equal(pickRes.ok, true);

  const trackers = localData[TRACKERS_KEY];
  assert.equal(trackers.length, 2);
  const updated = trackers.find((t) => t.id === "t1");
  const unchanged = trackers.find((t) => t.id === "t2");
  assert.equal(updated.selector, "new1");
  assert.equal(updated.anchor, "balance");
  assert.equal(unchanged.selector, "old2");
  assert.equal(unchanged.anchor, null);
});

test("training without trackerId still creates a new tracker", async () => {
  localData = {};
  sessionData = {};
  const armRes = await callListener({ type: "ebt:arm-training", tabId: 1, label: "New" });
  assert.equal(armRes.ok, true);

  const pickRes = await callListener({
    type: "ebt:picked",
    picked: { url: "https://example.com/page", selector: "new", text: "42", anchor: "balance" },
  });
  assert.equal(pickRes.ok, true);

  const trackers = localData[TRACKERS_KEY];
  assert.equal(trackers.length, 1);
  const t = trackers[0];
  assert.equal(t.label, "New");
  assert.equal(t.selector, "new");
  assert.equal(t.anchor, "balance");
});

test("picking text that is not a number saves nothing on retrain and on a new tracker", async () => {
  localData = {};
  sessionData = {};
  localData[TRACKERS_KEY] = [
    { id: "t1", label: "Test", urlPattern: "https://example.com", selector: "old", anchor: "a", history: [{ value: 1, unit: "USD", raw: "$1", source: "training", ts: 1 }] },
  ];
  await callListener({ type: "ebt:arm-training", tabId: 1, label: "Test", trackerId: "t1" });
  const bad = await callListener({ type: "ebt:picked", picked: { url: "https://example.com/p", selector: "new", text: "Sign in", anchor: "b" } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not a number/);
  const t = localData[TRACKERS_KEY][0];
  assert.equal(t.selector, "old");
  assert.equal(t.anchor, "a");
  assert.equal(t.history.length, 1);

  await callListener({ type: "ebt:arm-training", tabId: 1, label: "Fresh" });
  const bad2 = await callListener({ type: "ebt:picked", picked: { url: "https://example.com/p", selector: "x", text: "Welcome back", anchor: null } });
  assert.equal(bad2.ok, false);
  assert.equal(localData[TRACKERS_KEY].length, 1);
});
