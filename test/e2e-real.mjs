import puppeteer from "puppeteer";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const demoUrl = "http://127.0.0.1:8797/";
let serverProc = null;
let browsers = [];

function startServer() {
  return new Promise((resolve, reject) => {
    try {
      execSync(`curl -s -o /dev/null -w "%{http_code}" ${demoUrl}`);
      resolve(null); // already running
    } catch {
      serverProc = spawn("node", ["demo/serve.mjs"], { cwd: root, stdio: "ignore" });
      const timeout = setTimeout(() => reject(new Error("server timeout")), 10000);
      const check = () => {
        try {
          execSync(`curl -s -o /dev/null -w "%{http_code}" ${demoUrl}`);
          clearTimeout(timeout);
          resolve(serverProc);
        } catch {
          setTimeout(check, 200);
        }
      };
      check();
    }
  });
}

function copyExtension(modifyBackground = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ebt-ext-"));
  const filter = (src) => !src.includes("node_modules") && !src.includes(".git") && !src.includes("test");
  fs.cpSync(root, tmp, { recursive: true, filter });
  const manifestPath = path.join(tmp, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  if (modifyBackground) {
    const bgPath = path.join(tmp, "src/background.js");
    fs.writeFileSync(bgPath, `
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === "ebt:arm-training") {
          (async () => {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: msg.tabId, allFrames: true },
                files: ["src/content/content.js"]
              });
              await chrome.tabs.sendMessage(msg.tabId, { type: "ebt:start-training" });
            } catch (e) {
              // ignore errors
            }
            sendResponse({ ok: true, armed: true });
          })();
          return true; // keep channel open for async response
        }
        sendResponse({ ok: false, reason: "unknown-message" });
      });
    `);
  }
  return tmp;
}

async function launchBrowser(extPath) {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const browser = await puppeteer.launch({
      headless: "new",
      executablePath,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [`--load-extension=${extPath}`, "--enable-unsafe-extension-debugging", "--no-sandbox"]
    });
    browsers.push(browser);
    try {
      // First check existing targets
      const existing = browser.targets().find(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
      if (existing) {
        return { browser, id: new URL(existing.url()).host };
      }
      // Wait for target with longer timeout
      const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"), { timeout: 20000 });
      return { browser, id: new URL(sw.url()).host };
    } catch (err) {
      lastError = err;
      await browser.close().catch(() => {});
      // Remove from browsers array to avoid double-close
      browsers = browsers.filter(b => b !== browser);
    }
  }
  throw lastError || new Error("Failed to launch extension service worker after 3 attempts");
}

async function getDemoTab(popupPage) {
  return await popupPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:8797/*" });
    return tabs[0].id;
  });
}

async function runCaseA(browser, id) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 650 });
  await page.goto(demoUrl, { waitUntil: "load" });
  const pop = await browser.newPage();
  await pop.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await page.bringToFront();
  const tabId = await getDemoTab(pop);
  const arm = await pop.evaluate((tabId) => chrome.runtime.sendMessage({ type: "ebt:arm-training", tabId, label: "demo" }), tabId);
  if (!arm?.ok || !arm.armed) throw new Error("arm failed: " + JSON.stringify(arm));
  await new Promise(r => setTimeout(r, 800));
  await page.hover("#balance");
  await page.click("#balance");
  await new Promise(r => setTimeout(r, 1500));
  const list = await pop.evaluate(() => chrome.runtime.sendMessage({ type: "ebt:list" }));
  const tracker = list?.trackers?.find(t => t.label === "demo");
  if (!tracker || tracker.history[0]?.raw !== "$100.05") throw new Error("tracker missing or wrong raw");
  const ver = await pop.evaluate(() => chrome.runtime.sendMessage({ type: "ebt:version" }));
  if (!ver?.ok || typeof ver.build !== "string") throw new Error("version failed");
  console.log("PASS case A");
  await page.close();
  await pop.close();
}

async function runCaseB(browser, id) {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 650 });
  await page.goto(demoUrl, { waitUntil: "load" });
  const pop = await browser.newPage();
  await pop.goto(`chrome-extension://${id}/src/popup/popup.html`);
  await page.bringToFront();
  const tabId = await getDemoTab(pop);
  const ver = await pop.evaluate(() => chrome.runtime.sendMessage({ type: "ebt:version" }));
  if (ver?.ok || ver?.reason !== "unknown-message") throw new Error("version should fail");
  const arm = await pop.evaluate((tabId) => chrome.runtime.sendMessage({ type: "ebt:arm-training", tabId, label: "demo" }), tabId);
  if (!arm?.ok || !arm.armed) throw new Error("arm should succeed");
  await new Promise(r => setTimeout(r, 800));
  await page.hover("#balance");
  await page.click("#balance");
  await new Promise(r => setTimeout(r, 1500));
  // Poll for up to 4000ms for the toast text in documentElement.textContent
  const found = await new Promise((resolve) => {
    const start = Date.now();
    const check = async () => {
      const text = await page.evaluate(() => document.documentElement.textContent);
      if (text.includes("Ember is out of date")) {
        resolve(true);
      } else if (Date.now() - start >= 4000) {
        resolve(false);
      } else {
        setTimeout(check, 200);
      }
    };
    check();
  });
  if (!found) throw new Error("toast not found");
  const list = await pop.evaluate(() => chrome.runtime.sendMessage({ type: "ebt:list" }));
  if (!(list?.ok === false && list?.reason === "unknown-message")) throw new Error("expected unknown-message for list");
  console.log("PASS case B");
  await page.close();
  await pop.close();
}

async function main() {
  const timeout = setTimeout(() => { console.error("FAIL global timeout"); process.exit(1); }, 150000);
  try {
    await startServer();
    const extA = copyExtension(false);
    const { browser: bA, id: idA } = await launchBrowser(extA);
    await runCaseA(bA, idA);
    await bA.close();
    const extB = copyExtension(true);
    const { browser: bB, id: idB } = await launchBrowser(extB);
    await runCaseB(bB, idB);
    await bB.close();
    console.log("ALL PASS");
  } catch (e) {
    console.error("FAIL", e.message);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    for (const b of browsers) await b.close().catch(() => {});
    if (serverProc) serverProc.kill();
  }
}

main();
