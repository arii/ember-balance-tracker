import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveRegexWithEmber, DERIVE_MAX_TOKENS } from "../src/ember/client.js";

function stubFetch(body) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test("empty content cut off at the output limit is reported distinctly, no retry", async () => {
  const s = stubFetch({ choices: [{ message: { content: null }, finish_reason: "length" }], usage: { prompt_tokens: 97, completion_tokens: 2000, total_tokens: 2097 } });
  try {
    const r = await deriveRegexWithEmber({ apiKey: "k", label: "Balance", sampleText: "$100.05" });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "model-empty-output-limit");
    assert.ok(r.trace && r.trace.ok === true, "usage still traced");
    assert.equal(s.calls.length, 1, "exactly one request, no automatic retry");
    assert.equal(s.calls[0].body.max_tokens, DERIVE_MAX_TOKENS);
    assert.equal(s.calls[0].body.reasoning_effort, "low");
  } finally { s.restore(); }
});

test("empty content with a normal stop is model-empty", async () => {
  const s = stubFetch({ choices: [{ message: { content: "  " }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
  try {
    const r = await deriveRegexWithEmber({ apiKey: "k", label: "Balance", sampleText: "$100.05" });
    assert.equal(r.reason, "model-empty");
  } finally { s.restore(); }
});

test("derive output budget leaves headroom over the observed 2000-token reasoning burn", () => {
  assert.ok(DERIVE_MAX_TOKENS >= 4000);
});
