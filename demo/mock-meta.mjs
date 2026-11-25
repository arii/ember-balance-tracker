// Local-only mock for the /chat/completions subset used by src/ember/client.js.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const DERIVE_RESPONSES = {
  valid: String.raw`\$([\d,]+(?:\.\d{1,2})?)`,
  invalid: "(unclosed",
  dangerous: String.raw`(\$[\d.]+)\1`,
  none: "",
  "no-usage": String.raw`\$([\d,]+(?:\.\d{1,2})?)`,
};

export function createMockMetaServer({ deriveSequence = ["valid", "invalid", "dangerous", "none"], find = {} } = {}) {
  const calls = [];
  let deriveIndex = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end("not found");
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const isDerive = request.max_tokens === 60;
    const mode = isDerive ? deriveSequence[Math.min(deriveIndex++, deriveSequence.length - 1)] : "find";
    calls.push({ request, mode });
    // Failure simulation: "error" derives or find.status -> HTTP error with no usable body.
    const status = isDerive ? (mode === "error" ? 500 : 200) : (find.status ?? 200);
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "simulated failure" } }));
      return;
    }
    const content = isDerive ? DERIVE_RESPONSES[mode] : (find.content ?? "$100.05");
    const omitUsage = isDerive ? mode === "no-usage" : !!find.omitUsage;
    const usage = omitUsage ? undefined : (isDerive
      ? { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 }
      : { prompt_tokens: 80, completion_tokens: 4, total_tokens: 84 });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: "muse-ember-1.0",
      choices: [{ message: { role: "assistant", content } }],
      ...(usage ? { usage } : {}),
    }));
  });
  return {
    calls,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}/v1`;
    },
    async close() { await new Promise((resolve) => server.close(resolve)); },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const mock = createMockMetaServer();
  const base = await mock.listen();
  console.log(`mock Meta Model API on ${base}`);
}
