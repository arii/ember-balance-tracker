import { test } from "node:test";
import assert from "node:assert/strict";
import { restoreTracker } from "../src/lib/restore.js";

test("valid restore appends tracker", () => {
  const trackers = [{ id: "a", label: "A", selector: "s", urlPattern: "u", history: [] }];
  const tracker = { id: "b", label: "B", selector: "s", urlPattern: "u", history: [] };
  const result = restoreTracker(trackers, tracker);
  assert.equal(result.ok, true);
  assert.deepEqual(result.trackers, [...trackers, tracker]);
});

test("duplicate id rejects", () => {
  const trackers = [{ id: "a", label: "A", selector: "s", urlPattern: "u", history: [] }];
  const tracker = { id: "a", label: "B", selector: "t", urlPattern: "v", history: [] };
  const result = restoreTracker(trackers, tracker);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate");
});

test("invalid shape rejects missing selector", () => {
  const trackers = [];
  const tracker = { id: "b", label: "B", urlPattern: "u", history: [] };
  const result = restoreTracker(trackers, tracker);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("invalid shape rejects history not an array", () => {
  const trackers = [];
  const tracker = { id: "b", label: "B", selector: "s", urlPattern: "u", history: {} };
  const result = restoreTracker(trackers, tracker);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("invalid shape rejects null", () => {
  const trackers = [];
  const result = restoreTracker(trackers, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid");
});

test("input array is not mutated", () => {
  const original = [{ id: "a", label: "A", selector: "s", urlPattern: "u", history: [] }];
  const snapshot = JSON.parse(JSON.stringify(original));
  restoreTracker(original, { id: "b", label: "B", selector: "s", urlPattern: "u", history: [] });
  assert.deepEqual(original, snapshot);
});
