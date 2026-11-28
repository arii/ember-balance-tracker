# Ember Balance Tracker - test it on your machine

## What this is
Chrome MV3 extension. Teach it where a balance sits on any page ("Start training"),
then read it on demand for free via a learned regex. The Muse Ember (Meta Model API)
fallback is OFF by default and needs your API key.

## Set up (5 min)
1. git clone https://github.com/arii/ember-balance-tracker && cd ember-balance-tracker
2. npm install
3. npm test        # unit: expect 376 passed / 0 failed (as of main 4148c09)
4. npm run e2e     # real Chrome via puppeteer: expect 9 passed, screenshots in test/artifacts/
   # If puppeteer's bundled Chrome isn't downloaded, point at system Chrome:
   # PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome npm run e2e

## Try the extension itself
1. chrome://extensions -> Developer mode -> Load unpacked -> pick the repo folder
2. npm run demo    # serves a mock billing page
3. Open the demo page, click the toolbar icon (puzzle menu, then Ember Balance Tracker; this click grants access to the tab), type a label, click "Start training", then click the $ amount on the page. Checked with real toolbar clicks on the demo page only, not a real billing site or live Ember.
4. Days-later flow: click "Read now" - instant, no API call
5. Try demo/redesigned.html (honest "can't find it - refresh or re-teach") and
   demo/ambiguous.html (only your labeled element is read)

## Optional: Ember fallback (your Meta key, your calls)
- Settings page: enable Ember, paste your Meta Model API key (stored in chrome.storage.local
  only), optionally allow page-text fallback (separate consent)
- Successful API responses with usage are logged to the trace (model, tokens, cost, cumulative vs $10) - that JSON
  export can support the hackathon proof-of-usage artifact after real calls

## Readiness gaps (honest)
- Regex derivation quality against the REAL muse-ember-1.0 is unverified - only mocked.
  First live derive may need prompt tuning.
- Meta API request/response shape is from public docs, not a live call.
- The extension pins the model client-side. Its $10 trace summary is informational,
  not an enforced spending cap. Vendor-side key restrictions were not verified.
- Repo has no LICENSE for your own code yet - your call (MIT is common for hackathons).
- Submission needs the public repo (done) + the prompt/token trace (format ready,
  needs real runs).

## Refresh visibility (build 2026-11-28-c)
1. Track a balance, wait over 5 minutes (or age the reading), then switch to that tab: the toolbar icon shows a badge and its tooltip says the balance may be out of date.
2. Open the popup: Refresh is a visible button on the row, not inside More. Click it: the value updates, the meta line says "just now" and the badge clears.
3. Make the read fail (remove the element): the row shows "last good read X ago, latest check failed", with the old value dimmed. It must never look fresh.
