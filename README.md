# Ember Balance Tracker

A Chrome MV3 extension that tracks credit and balance amounts on pages you already use.
You teach it once ("track this balance"), it reads the value on demand afterwards.

Built for the [Muse Ember Hackathon](https://cerebralvalley.ai/e/muse-ember-hackathon) (Nov 23 - Dec 2, 2026).

## How it works

1. Open a page where you're already signed in (no separate login, no cookies touched -
   the extension just reads the visible page in your current tab).
2. Click the extension, enter a label ("Runware credits"), click **Track this balance**,
   then click the number on the page.
3. Later, click **Read now** to re-read the value. Readings are kept in a local history.
   If you're on another tab, it finds your dashboard's open tab and switches to it.

A tracker saves the number's visible label as an anchor. On every read the extension re-finds that label; if the page layout changes and the number moves, it either heals to the right number (label found once) or refuses and shows the last value marked "Stale: needs attention" (label missing or more than one match). It never silently shows a different number.

If a learned read fails (page changed, session expired), the extension asks you to
refresh the page or re-teach it.

## Trackers from older versions

Trackers created before anchors keep their history but show "unverified". Each such row has a Re-track button - click it on that tracker's own site, then click the number once. It keeps the tracker id, label and history, installs the anchor, and is rejected if the page origin differs. "Track this balance" still creates a separate new tracker; nothing is merged by label.

## The Muse Ember role (hybrid by design)

Deterministic first, AI once:

- During training, the extension can ask **Muse Ember** (Meta Model API) for a
  **deterministic extraction regex** for that site's balance text. The pattern is
  treated as data, compiled safely, and **accepted only if it reproduces the exact
  value you just clicked**. One AI call per site, at a fraction of a cent
  ($0.10/M input, $0.50/M output tokens).
- Every later read uses the saved selector + regex. No AI call, no cost, instant.
- If the element still exists but deterministic parsing fails, a separately
  consented Ember call can read visible page text. A missing selector asks you to
  refresh/re-teach instead.

The AI fallback is **off by default**. Enable it in Options with your own Meta Model
API key. Every call is recorded with token usage and estimated cost in a local
**usage trace** (Options > Export trace JSON) - the hackathon's proof-of-usage artifact.

## What is verified and what is not

426 unit tests pass (npm test, build 2026-11-26-c). Real-Chrome e2e with the real toolbar passes on a replica of a billing page (swapped tiles heal, an inserted second Balance card is refused as stale). NOT verified: live provider sites (the cloud browser cannot load the extension), so a real Chrome session is the live check; two numbers with the same label cause a refusal by design.

## Privacy

- Permissions: `activeTab`, `storage`, `scripting`, `tabs`. No host permissions, no
  `cookies`. `tabs` is only used to find your dashboard's already-open tab when you
  click Read now; page content is still only read after your click via `activeTab`.
- Nothing leaves the browser unless you enable the Ember fallback, and then only the
  page's visible text (capped at 4,000 chars) is sent to Meta's API. Never cookies,
  never credentials.
- All trackers, history, settings and the usage trace live in `chrome.storage.local`.

## Development

Zero-dependency vanilla MV3 - no build step; judges read the source as-is.

```bash
npm install     # dev tools only (jsdom, puppeteer)
npm test        # unit tests: parsing, selectors, regex safety, consent, mock API, trace math, multi-frame reads, fixture-driven extraction, anchor verification, stale handling, Re-track
npm run e2e     # real Chrome: loads the unpacked extension, runs the train/read flow
npm run demo    # serves demo/index.html (mock billing page) on :8797
```

### Test fixtures

`test/fixtures/adaption-balance-pages.json` holds 98 synthetic billing and usage page texts,
generated with Adaption for evaluation. They are fictional (no real accounts or sites), each with
the expected balance, unit and label. `test/adaption-fixtures.test.js` runs them through
`parseBalance`, `extractWithPattern` and `validatePattern`. They test the text parsing and regex
layers only. They do not exercise the browser DOM, selector learning, or a live Ember call.

Load unpacked: `chrome://extensions` > Developer mode > Load unpacked > this folder.

Historical third-party guidance was removed from the source tree; its license notice is retained in `NOTICE`.

See [HARDWARE-TESTING.md](HARDWARE-TESTING.md) for local setup and the remaining real-API checks.
