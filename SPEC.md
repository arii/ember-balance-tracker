# Ember Balance Tracker - Spec

## 1. Product

A Chrome extension that tracks usage and credit balances shown on the web dashboards of
AI and cloud services. The user teaches it once per site by clicking the balance on the
page; later reads are deterministic and need no model call.

Principles:

- Uses the existing browser session. No separate login, no credential handling, no
  cookie access or export.
- A stale page or session is a visible prompt to refresh, never a silent wrong value.
- Click-to-teach: open the page, click the extension, click the balance.
- AI is a fallback and accelerator, not the hot path. At training time the Muse Ember
  model can derive a deterministic extraction pattern; later reads reuse that pattern
  for free.

## 2. User stories

1. On a billing page, I click "Track this balance", give it a label and click the
   balance element. No API keys or scraping config.
2. Later I click "Read now" and see the current value, stored in history.
3. If the site changed, I see "can't find it - refresh or teach again", not a wrong
   number.
4. I can export the history as JSON.
5. I can see every Ember call the extension made, with tokens and estimated cost, in an
   exportable usage trace.

## 3. Architecture

Vanilla JS MV3, zero runtime dependencies, no build step.

- `manifest.json` - permissions: `activeTab`, `storage`, `scripting`. No host permissions.
- `src/content/content.js` - training picker (hover highlight, click capture, Esc
  cancel), element reader, visible-text sampler. Injected per user gesture only.
- `src/background.js` - service worker: tracker CRUD, read orchestration, trace log. The
  training flow completes in the background so the popup can close while the user clicks
  the page.
- `src/popup/` - label input, tracker list, read and delete actions.
- `src/options/` - Ember fallback toggle, API base URL and key (stored locally), trace
  viewer and export.
- `src/ember/client.js` - model API client: `deriveRegexWithEmber` (training) and
  `findBalanceWithEmber` (last-resort read). No key is bundled.
- `src/lib/parse.js` - balance text parsing ($, credits/points/CR, "x of y used", bare
  numbers).
- `src/lib/selector.js` - resilient selector generation (stable `#id` > `data-*`
  attributes > `nth-of-type` path).
- `src/lib/regexcheck.js` - safety checks for model-derived patterns. The pattern is
  model output and the input text comes from arbitrary pages, and JS regexes have no
  timeout, so the defense is a restricted subset plus input caps: pattern length cap
  (200), input cap (5,000 chars), no backreferences, no quantifiers above `{64}`, no
  nested quantified groups, no ambiguous quantified alternation (`(a|ab)+`), at most one
  greedy wildcard, and acceptance only if the pattern reproduces the training value.
  Patterns are data; no `eval` and no generated code. Covered by adversarial unit tests;
  this is defense in depth, not a formal proof.
- `src/lib/trace.js` - usage and cost math for the trace, with a budget summary.

Read precedence: learned pattern > generic parser on the element text > optional Ember
call on the page text > "refresh / teach again" prompt.

## 4. Security and privacy

- No `cookies` permission. Session reuse is implicit (the page is already signed in);
  the extension never reads or exports session data.
- Model output is data (a pattern string or a short answer) and is validated before use.
- Page text is sent to the model API only when the fallback is explicitly enabled, capped
  at 4,000 characters.
- The API key lives in `chrome.storage.local`, is never synced and is never in the repo.

## 5. Status

- Unit tests cover parsing, selectors, pattern safety and validation, and trace math
  (`npm test`).
- An end-to-end check in Chrome covers loading the extension, training on the demo page,
  selector resolution, read-back, stale-selector reporting, the popup list and storage
  shared with the service worker (`npm run e2e`). Screenshots go to `test/artifacts/`.
- Not yet done: a live model API call, training on real sites and pattern derivation end
  to end. The `activeTab` script injection needs a real user gesture, so it is checked
  manually, not in CI.
