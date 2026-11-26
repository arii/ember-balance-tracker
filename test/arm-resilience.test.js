// Regression tests for the iframe train/save failure chain:
//  1. content.js must survive being injected twice into the same isolated
//     world (top-level `let` redeclaration used to kill the second injection
//     with a SyntaxError, leaving the frame with no working picker).
//  2. A throwing message handler must respond ok:false with the reason
//     (previously the rejection was unhandled and picks vanished silently).
//  3. armAllFrames must inject content.js per-frame where the listener is
//     missing and report armed:false when no frame can be reached.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

test("content.js can be evaluated twice in the same world and installs one listener", () => {
  const src = readFileSync(new URL("../src/content/content.js", import.meta.url), "utf8");
  let listeners = 0;
  const sandbox = {
    console,
    chrome: { runtime: { onMessage: { addListener() { listeners++; } } } },
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.doesNotThrow(() => vm.runInContext(src, sandbox));
  assert.equal(listeners, 1, "second evaluation must be a no-op");
});

// --- handler + armAllFrames, against the real background.js ---

let listener;
let sendMessageCalls;
let injectCalls;
let sessionThrows = false;
let pingOkByFrame = {};
let injectFails = false;
let enumerateFails = false;
let sessionValue = null;

globalThis.chrome = {
  runtime: { onMessage: { addListener(fn) { listener = fn; } } },
  storage: {
    local: {
      async get() { return {}; },
      async set() {},
    },
    session: {
      async get() { if (sessionThrows) throw new Error("session gone"); return { pendingTraining: sessionValue }; },
      async set(v) { sessionValue = v.pendingTraining; },
      async remove() {},
    },
  },
  scripting: {
    async executeScript({ func, target }) {
      if (func && enumerateFails) throw new Error("Cannot access page");
      if (func) return [{ frameId: 0, result: "http://x/" }, { frameId: 7, result: "http://x/child" }];
      injectCalls.push(target?.frameIds ?? null);
      if (injectFails) throw new Error("Extension manifest must request permission to access this host");
      return [{}];
    },
  },
  tabs: {
    async sendMessage(tabId, msg, { frameId } = {}) {
      sendMessageCalls.push({ type: msg.type, frameId });
      if (msg.type === "ebt:read") {
        if (!pingOkByFrame[frameId]) throw new Error("Could not establish connection. Receiving end does not exist");
        return { ok: true, text: "x" };
      }
      if (msg.type === "ebt:start-training") return { ok: true, armed: true };
      return { ok: true };
    },
  },
};

let armAllFrames;
before(async () => {
  ({ armAllFrames } = await import("../src/background.js"));
});

function dispatch(msg, sender = { tab: { id: 1 } }) {
  return new Promise((resolve) => listener(msg, sender, resolve));
}

test("a throwing handler responds ok:false with the reason instead of failing silently", async () => {
  sessionThrows = true;
  const res = await dispatch({ type: "ebt:picked", picked: { selector: ".credits", text: "$1.00", url: "http://x/" } });
  sessionThrows = false;
  assert.equal(res.ok, false);
  assert.match(res.reason, /^handler-error: /);
  assert.match(res.reason, /session gone/);
});

test("armAllFrames injects only frames missing a listener and arms every frame", async () => {
  sendMessageCalls = [];
  injectCalls = [];
  pingOkByFrame = { 0: true, 7: false }; // child frame lost its listener
  injectFails = false;
  const res = await armAllFrames(42);
  assert.deepEqual(res, { armed: true, frameCount: 2 });
  assert.deepEqual(injectCalls, [[7]], "only the listener-less frame is re-injected");
  const starts = sendMessageCalls.filter((c) => c.type === "ebt:start-training").map((c) => c.frameId);
  assert.deepEqual(starts, [0, 7], "every frame is armed individually");
});

test("armAllFrames reports armed:false when no frame can be reached", async () => {
  sendMessageCalls = [];
  injectCalls = [];
  pingOkByFrame = { 0: false, 7: false };
  injectFails = true;
  const res = await armAllFrames(42);
  assert.equal(res.armed, false);
});


test("arm dispatch acknowledges actual failure and clears pending state", async () => {
  enumerateFails = true;
  const res = await dispatch({ type: "ebt:arm-training", tabId: 42, label: "credits" });
  enumerateFails = false;
  assert.equal(res.ok, false);
  assert.equal(res.armed, false);
  assert.equal(sessionValue, null);
});

test("arm dispatch reports session errors instead of detached rejection", async () => {
  sessionThrows = true;
  const res = await dispatch({ type: "ebt:arm-training", tabId: 42, label: "credits" });
  sessionThrows = false;
  assert.equal(res.ok, false);
  assert.match(res.reason, /session gone/);
});

test("arm dispatch waits for successful per-frame arming", async () => {
  sendMessageCalls = [];
  injectCalls = [];
  injectFails = false;
  pingOkByFrame = { 0: true, 7: false };
  const res = await dispatch({ type: "ebt:arm-training", tabId: 42, label: "credits" });
  assert.equal(res.ok, true);
  assert.equal(res.armed, true);
  assert.equal(sessionValue.tabId, 42);
  assert.equal(sendMessageCalls.filter(c => c.type === "ebt:start-training").length, 2);
});
