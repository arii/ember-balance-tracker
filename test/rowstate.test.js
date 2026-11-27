import test from 'node:test';
import assert from 'node:assert/strict';
import { rowState } from '../src/lib/format.js';

test('rowState returns "empty" when there is no history', () => {
  assert.equal(rowState({}), 'empty');
  assert.equal(rowState({ history: [] }), 'empty');
});

test('rowState returns "stale" when lastFailure.ts is later than last history timestamp', () => {
  const t = {
    history: [{ ts: 1000 }],
    lastFailure: { ts: 2000 },
  };
  assert.equal(rowState(t), 'stale');
});

test('rowState returns "unverified" when there is history but no anchor', () => {
  const t = {
    history: [{ ts: 1000 }],
    lastFailure: null,
    anchor: undefined,
  };
  assert.equal(rowState(t), 'unverified');
});

test('rowState returns "ok" when history has an anchor', () => {
  const t = {
    history: [{ ts: 1000 }],
    anchor: { ts: 1001 },
    lastFailure: null,
  };
  assert.equal(rowState(t), 'ok');
});

test('rowState returns "stale" even when unverified', () => {
  const t = {
    history: [{ ts: 1000 }],
    lastFailure: { ts: 2000 },
    anchor: undefined,
  };
  assert.equal(rowState(t), 'stale');
});
