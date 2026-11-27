import { describeReadFailure } from "../src/lib/messages.js";
import { test } from "node:test";
import assert from "node:assert/strict";

test("anchor-ambiguous", () => {
  const result = describeReadFailure("anchor-ambiguous", "Balance");
  assert.equal(
    result,
    `The page now shows more than one "Balance" number, so Ember will not guess. Showing the last good value as stale. Open the right page and use Re-track to pick the correct number.`
  );
});

test("anchor-mismatch", () => {
  const result = describeReadFailure("anchor-mismatch", "Balance");
  assert.equal(
    result,
    `The "Balance" label is no longer next to the tracked number, so the layout changed. Showing the last good value as stale. Use Re-track to pick the number again.`
  );
});

test("selector-not-found", () => {
  const result = describeReadFailure("selector-not-found", "Balance");
  assert.equal(
    result,
    `Ember could not find the "Balance" number on this page. Refresh the page (sign in if asked), then read again.`
  );
});

test("empty", () => {
  const result = describeReadFailure("empty", "Balance");
  assert.equal(
    result,
    `The "Balance" number on this page is empty right now. Refresh the page and read again.`
  );
});

test("stale-pick", () => {
  const result = describeReadFailure("stale-pick", "Balance");
  assert.equal(
    result,
    `The number you clicked changed before it was saved. Try picking it again.`
  );
});

test("empty label falls back to this balance", () => {
  assert.equal(
    describeReadFailure("anchor-ambiguous", ""),
    `The page now shows more than one "this balance" number, so Ember will not guess. Showing the last good value as stale. Open the right page and use Re-track to pick the correct number.`
  );
  assert.equal(
    describeReadFailure("empty", null),
    `The "this balance" number on this page is empty right now. Refresh the page and read again.`
  );
});

test("undefined reason returns unknown error", () => {
  const result = describeReadFailure(undefined, "Balance");
  assert.equal(result, `Could not read "Balance" (unknown error).`);
});

test("no anchor- substring in anchor/selector cases", () => {
  const cases = ["anchor-ambiguous", "anchor-mismatch", "selector-not-found", "empty"];
  for (const reason of cases) {
    const text = describeReadFailure(reason, "Balance");
    assert.ok(!text.includes("anchor-"), `found "anchor-" in: ${text}`);
  }
});
