// Bounded live test of the Ember fallback path against the real Meta Model API.
// Proof for the hackathon's "show prompt/token usage" requirement AND the
// calibration gate for the spend guard: exercises the production client,
// prompts and pricing code, with a hard dollar cap and a persistent ledger.
//
//  - PRE-SEND RESERVATION, HONEST BOUND: the client serializes the exact
//    request body and reports its real UTF-8 byte count + output cap to the
//    preSend gate BEFORE fetch; a gate denial means no HTTP leaves at all.
//    The reservation is priced from the PROVABLE bound (official context
//    window x long-context rate + max_tokens x long-context output rate),
//    not from any tokens-per-byte assumption - Meta documents no such ratio.
//    The measured bytes are recorded as expected size; every call settles at
//    ACTUAL provider-reported usage, tier-aware.
//  - SHARED AGGREGATE LEDGER: scripts/live-ledger.json persists across runs
//    and holds every attempt, including auth probes, failed calls and debug
//    runs. It is gitignored and private: token/cost figures only, never
//    prompts, page text, or responses. A corrupt or unreadable ledger REFUSES
//    the run (it may hold real spend; resetting to zero would silently raise
//    the effective cap), as does any malformed entry.
//  - CROSS-PROCESS LOCK: a mkdir lockfile refuses parallel runs, which could
//    double-spend against the same ledger.
//  - ONE IN FLIGHT: steps run sequentially; each reservation is written to
//    the ledger before its request is sent. Provider-reported usage is
//    validated against the measured reservation afterwards: an excess charges
//    the actual higher cost and aborts; an HTTP error or missing usage keeps
//    the full reservation and aborts.
//  - NO SECRETS OR USER CONTENT OUT: the key arrives as EMBER_TEST_KEY, is
//    never printed, and the ledger stores figures only.
//
// Usage: EMBER_TEST_KEY=... node scripts/live-meta-test.mjs
// Optional: EMBER_TEST_CAP_USD (default 2), EMBER_API_BASE (default production).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRegexWithEmber, findBalanceWithEmber, DEFAULT_API_BASE } from "../src/ember/client.js";
import { worstCaseCost, summarizeTrace, MAX_TIER_BODY_BYTES } from "../src/lib/trace.js";
import { validatePattern } from "../src/lib/regexcheck.js";
import { parseBalance } from "../src/lib/parse.js";

const CAP_USD = Number(process.env.EMBER_TEST_CAP_USD || 2);
if (!Number.isFinite(CAP_USD) || CAP_USD <= 0) {
  console.error(`invalid cap "${process.env.EMBER_TEST_CAP_USD}": refusing to run with an untrustworthy cap`);
  process.exit(2);
}
const API_KEY = process.env.EMBER_TEST_KEY || "";
const API_BASE = process.env.EMBER_API_BASE || DEFAULT_API_BASE;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_PATH = path.join(root, "scripts", "live-ledger.json");

if (!API_KEY) {
  console.error("EMBER_TEST_KEY is required (vault sandbox copy; never paste it anywhere else).");
  process.exit(2);
}

// Three steps, fixed payloads: (1) auth + simplest find, (2) the training-time
// derive call, (3) a find on multi-dollar page text where naive regexes pick
// the wrong amount. Input size is whatever the production client actually
// serializes for these payloads - the gate measures it.
const steps = [
  {
    name: "auth-shape",
    run: (preSend) => findBalanceWithEmber({ apiBase: API_BASE, apiKey: API_KEY, label: "Account balance", pageText: "Account balance: $1.00", preSend }),
    verify: (r) => {
      if (!r.ok) return `auth call failed: ${r.reason}`;
      const parsed = parseBalance(r.text);
      return parsed.ok ? null : `response not a parseable balance: ${JSON.stringify(r.text)}`;
    },
  },
  {
    name: "derive-regex",
    run: (preSend) => deriveRegexWithEmber({ apiBase: API_BASE, apiKey: API_KEY, label: "Runware credits", sampleText: "Available balance: $100.05", preSend }),
    verify: (r) => {
      if (!r.ok) return `derive failed: ${r.reason}`;
      const check = validatePattern(r.pattern, "Available balance: $100.05", parseBalance("Available balance: $100.05").value);
      return check.accepted ? null : `derived pattern rejected: ${check.reason}`;
    },
  },
  {
    name: "find-ambiguous",
    run: (preSend) => findBalanceWithEmber({
      apiBase: API_BASE, apiKey: API_KEY, label: "Available balance",
      pageText: "Account overview Last payment: $24.00 Plan price: $49.00 Available balance: $100.05 Pending charge: $7.50",
      preSend,
    }),
    verify: (r) => {
      if (!r.ok) return `find failed: ${r.reason}`;
      const parsed = parseBalance(r.text);
      return parsed.ok && parsed.value === 100.05 ? null : `expected 100.05, got ${JSON.stringify(r.text)}`;
    },
  },
];

// Fail closed on corruption: a ledger we cannot parse may hold real spend,
// and resetting it to zero would silently raise the effective cap. A malformed
// entry (negative/NaN/missing amounts) is corruption too - refuse, never guess.
async function loadLedger() {
  let raw;
  try {
    raw = await readFile(LEDGER_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { capUsd: CAP_USD, entries: [] };
    console.error(`ledger unreadable (${err.message}); refusing to run - inspect ${LEDGER_PATH}`);
    process.exit(2);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error("missing entries array");
    parsed.entries.forEach((e, i) => {
      const bad = !e || typeof e !== "object"
        || !Number.isFinite(e.reservedUsd) || e.reservedUsd < 0
        || (e.actualCostUsd != null && (!Number.isFinite(e.actualCostUsd) || e.actualCostUsd < 0));
      if (bad) throw new Error(`entry ${i} malformed`);
    });
    return parsed;
  } catch (err) {
    console.error(`ledger corrupt (${err.message}); refusing to run - inspect ${LEDGER_PATH}`);
    process.exit(2);
  }
}

// Cross-process lock: a second concurrent run could double-spend against the
// same ledger. mkdir is atomic on POSIX; EEXIST means another run holds it.
// There is NO automatic stale-break: a paused holder (SIGSTOP, debugger) is
// alive but unverifiable, PID files race, and PID reuse is real, so an
// "is it dead?" check can hand the ledger to two runs at once. Fail closed
// instead: refuse and tell the operator to remove the lockfile by hand after
// confirming no run is active. Cleanup on exit must be SYNCHRONOUS: 'exit'
// handlers never run async work, and an async rm here leaks the lock.
const LOCK_PATH = LEDGER_PATH + ".lock";
async function acquireLock() {
  try {
    await mkdir(LOCK_PATH);
    await writeFile(path.join(LOCK_PATH, "pid"), String(process.pid)).catch(() => {});
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    let holder = "unknown";
    try { holder = (await readFile(path.join(LOCK_PATH, "pid"), "utf8")).trim(); } catch {}
    console.error(`ledger lock ${LOCK_PATH} is held (recorded pid ${holder}); refusing to run in parallel`);
    console.error("if you have confirmed no other run is active, remove that directory by hand and retry");
    process.exit(2);
  }
  process.on("exit", () => { try { rmSync(LOCK_PATH, { recursive: true, force: true }); } catch {} });
}

function ledgerSpent(ledger) {
  // Actual where known, full reservation where the charge is unknown
  // (failed/aborted) - fail closed, never optimistic.
  return ledger.entries.reduce((sum, e) => {
    const actual = Number.isFinite(e.actualCostUsd) && e.actualCostUsd >= 0 ? e.actualCostUsd : null;
    return sum + (actual ?? e.reservedUsd);
  }, 0);
}

await acquireLock();
const ledger = await loadLedger();
console.log(`cap: $${CAP_USD} · prior ledger spend (worst-case basis): $${ledgerSpent(ledger).toFixed(6)} over ${ledger.entries.length} attempt(s)`);

const traces = [];
let abort = false;

for (const step of steps) {
  if (abort) break;
  let entry = null;

  // The production client calls this gate AFTER serializing the exact request
  // body and BEFORE fetch. Reserve the measured cost; deny = no HTTP at all.
  const preSend = async ({ bodyBytes, maxTokens }) => {
    if (!Number.isFinite(bodyBytes) || bodyBytes <= 0 || bodyBytes > MAX_TIER_BODY_BYTES) {
      return { allowed: false, reason: "body-bound-invalid" };
    }
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      return { allowed: false, reason: "output-cap-invalid" };
    }
    const reservedUsd = worstCaseCost({ maxTokens });
    const projected = ledgerSpent(ledger) + reservedUsd;
    if (projected > CAP_USD) {
      return { allowed: false, reason: "cap-exceeded", projectedUsd: projected, reservedUsd };
    }
    entry = {
      step: step.name, ts: new Date().toISOString(),
      reservationId: `res-${ledger.entries.length}`,
      bodyBytes, maxTokens, reservedUsd, status: "reserved",
    };
    ledger.entries.push(entry);
    await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    console.log(`CALL  ${step.name} (body ${bodyBytes}B, out<=${maxTokens}, reserved $${reservedUsd.toFixed(6)})`);
    return { allowed: true, reservationId: entry.reservationId };
  };

  let result;
  try {
    result = await step.run(preSend);
  } catch (err) {
    if (entry) {
      entry.status = `exception-${err.name}`;
      await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
    }
    console.log(`STOP  ${step.name}: unexpected ${err.name}; reservation stands as bounded worst case`);
    abort = true; // a bare break here would print ALL LIVE CHECKS PASSED with exit 0
    break;
  }

  if (!entry) {
    // The gate denied before any request left (cap reached or invalid body):
    // nothing was spent and no trace exists. The guard did its job; stop.
    console.log(`STOP  ${step.name}: pre-send gate denied (${result?.reason || "unknown"}); no request was sent`);
    abort = true;
    continue;
  }

  if (!result.trace) {
    // Client invariant: a sent request always yields a trace. Traceless here
    // means the invariant broke; keep the full reservation and stop.
    entry.status = "aborted-no-trace";
    entry.reason = result.reason || "unknown";
    abort = true;
  } else if (result.trace.reservationId !== entry.reservationId) {
    // The trace must point at the reservation that paid for it.
    entry.status = "reservation-mismatch";
    abort = true;
  } else {
    traces.push({ step: step.name, ...result.trace });
    if (!result.trace.ok || result.trace.usageKnown !== true) {
      // HTTP error or missing usage: charge stays at the reservation. Stop.
      entry.status = result.trace.ok ? "unknown-usage" : `failed-${result.trace.error}`;
      abort = true;
    } else if (
      result.trace.completionTokens > entry.maxTokens ||
      result.trace.costUsd > entry.reservedUsd
    ) {
      // Provider-reported billing beat the reservation (should be impossible:
      // output is capped server-side, input cannot exceed the context
      // window). Charge the ACTUAL higher cost, flag it, and stop.
      entry.status = "usage-exceeds-reservation";
      entry.usage = { prompt: result.trace.promptTokens, completion: result.trace.completionTokens };
      entry.actualCostUsd = result.trace.costUsd;
      abort = true;
    } else {
      entry.status = "ok";
      entry.usage = { prompt: result.trace.promptTokens, completion: result.trace.completionTokens };
      entry.actualCostUsd = result.trace.costUsd;
      const problem = step.verify(result);
      if (problem) { entry.status = `verify-failed: ${problem}`; abort = true; }
    }
  }
  await writeFile(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  console.log(`${entry.status === "ok" ? "OK   " : "STOP "} ${step.name}: ${entry.status}${entry.actualCostUsd != null ? ` · actual $${entry.actualCostUsd.toFixed(6)} (${entry.usage.prompt}+${entry.usage.completion} tokens)` : ""}`);
}

const spent = ledgerSpent(ledger);
const known = summarizeTrace(traces);
console.log("---");
console.log(`run calls: ${traces.length} · ledger total (worst-case basis): $${spent.toFixed(6)} of $${CAP_USD} cap`);
console.log(`this run's metered cost: ${known.costUsd?.toFixed(6) ?? "unknown"} (${known.promptTokens}+${known.completionTokens} tokens)`);
if (abort || traces.some((t) => !t.ok)) {
  console.log("run ended early or with failures; reservation(s) stand as bounded worst case");
  process.exit(1);
}
console.log("ALL LIVE CHECKS PASSED");
