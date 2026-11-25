// E2E: real Chrome, real extension pages, classic-script picker/read on a demo site.
// Usage: node test/e2e.mjs   (screenshots land in test/artifacts/)
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "test", "artifacts");
await mkdir(artifacts, { recursive: true });

const DEMO_URL = "http://127.0.0.1:8797/";
const alreadyServing = await fetch(DEMO_URL).then((r) => r.ok).catch(() => false);
let server = null;
if (alreadyServing) {
  console.log("demo server already running, reusing it");
} else {
  server = spawn(process.execPath, [path.join(root, "demo", "serve.mjs")], { stdio: "pipe" });
  let stderr = "";
  server.stderr.on("data", (d) => { stderr += d; });
  server.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`demo server exited early (code ${code}):\n${stderr}`);
      process.exit(2);
    }
  });
  process.on("exit", () => { try { server.kill(); } catch {} });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`demo server did not start in 10s:\n${stderr}`)), 10000);
    server.stdout.once("data", () => { clearTimeout(timer); resolve(); });
    server.once("exit", (code) => { clearTimeout(timer); reject(new Error(`demo server exited (code ${code}):\n${stderr}`)); });
  });
}

setTimeout(() => { console.error("E2E global timeout"); process.exit(2); }, 90000).unref();

const browser = await puppeteer.launch({
  headless: process.env.EBT_HEADFUL ? false : "new",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH || undefined,
  // Branded Chrome ignores --disable-extensions-except and ships with
  // puppeteer's --disable-extensions default, so drop that default instead.
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [
    `--load-extension=${root}`,
    "--enable-unsafe-extension-debugging",
    "--no-sandbox",
  ],
});

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

try {
  // 1. Extension service worker is alive -> extension loads in real Chrome.
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker", { timeout: 15000 });
  const swUrl = swTarget.url();
  check("extension service worker registered", swUrl.includes("src/background.js"), swUrl);
  const extensionId = new URL(swUrl).host;

  // 2. Demo page: drive the training picker like a user would.
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 650 });
  await page.goto("http://127.0.0.1:8797/", { waitUntil: "load" });
  await page.evaluate(() => { window.__ebtSelectorUrl = "/ext/src/lib/selector.js"; });
  await page.addScriptTag({ path: path.join(root, "src", "content", "content.js") });
  await page.waitForFunction("window.__ebt !== undefined", { timeout: 10000 });

  const picking = page.evaluate(() => window.__ebt.startTraining());
  await page.waitForSelector(".ebt-picker-highlight", { visible: true }).catch(() => {});
  await page.hover("#balance");
  await page.screenshot({ path: path.join(artifacts, "e2e-1-training-highlight.png") });
  await page.click("#balance");
  const picked = await picking;
  check("training picks the clicked balance", picked?.text === "$100.05", JSON.stringify(picked));
  check("picked selector resolves", (await page.$(picked?.selector || "#nope")) !== null, picked?.selector);

  // 3. Read it back (the "Read now" path).
  const read = await page.evaluate((sel) => window.__ebt.readAt(sel), picked.selector);
  check("read returns the balance text", read?.ok === true && read.text.includes("100.05"), JSON.stringify(read));

  // 4. Stale selector is reported (the refresh-prompt path).
  const gone = await page.evaluate(() => window.__ebt.readAt("#does-not-exist"));
  check("missing element reports selector-not-found", gone?.ok === false && gone.reason === "selector-not-found");

  // 5. Fixtures: redesign is honest about a stale selector; ambiguity stays scoped to the taught element.
  await page.goto("http://127.0.0.1:8797/redesigned.html", { waitUntil: "load" });
  await page.addScriptTag({ path: path.join(root, "src", "content", "content.js") });
  await page.waitForFunction("window.__ebt !== undefined", { timeout: 10000 });
  const redesigned = await page.evaluate(() => window.__ebt.readAt("#balance"));
  check("redesign reports cannot-find/re-teach state", redesigned?.ok === false && redesigned.reason === "selector-not-found");

  await page.goto("http://127.0.0.1:8797/ambiguous.html", { waitUntil: "load" });
  await page.addScriptTag({ path: path.join(root, "src", "content", "content.js") });
  await page.waitForFunction("window.__ebt !== undefined", { timeout: 10000 });
  const ambiguous = await page.evaluate(() => window.__ebt.readAt("#labeled-balance"));
  check("ambiguous page reads only the user-labeled element", ambiguous?.ok === true && ambiguous.text === "$100.05", JSON.stringify(ambiguous));

  // 6. Popup renders in the extension context with a seeded tracker.
  const popup = await browser.newPage();
  await popup.setViewport({ width: 360, height: 520 });
  await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`, { waitUntil: "load" });
  await popup.evaluate(() =>
    chrome.runtime.sendMessage({
      type: "ebt:add-tracker",
      label: "Acme balance (demo)",
      selector: "#balance",
      url: "http://127.0.0.1:8797/",
    })
  );
  await popup.reload({ waitUntil: "load" });
  await popup.waitForSelector("#tracker-list li");
  const popupText = await popup.$eval("body", (b) => b.innerText);
  check("popup lists the seeded tracker", popupText.includes("Acme balance (demo)"));
  await popup.screenshot({ path: path.join(artifacts, "e2e-2-popup.png") });

  // 6. Extension storage (shared with the service worker) holds the tracker.
  const stored = await popup.evaluate(async () => {
    const { trackers } = await chrome.storage.local.get("trackers");
    return trackers?.[0]?.label || null;
  });
  check("extension storage holds the tracker", stored === "Acme balance (demo)", String(stored));
  // Note: the full executeScript read path needs the activeTab grant, which
  // only a real user gesture (clicking the toolbar action) provides; it is
  // covered manually per SPEC.md, not in automation.

  console.log(failures === 0 ? "ALL E2E CHECKS PASSED" : `${failures} E2E CHECK(S) FAILED`);
} finally {
  await browser.close();
  if (server) server.kill();
}
process.exit(failures ? 1 : 0);
