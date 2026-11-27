import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithPattern } from '../src/lib/regexcheck.js';
import { readWithFallback } from '../src/lib/fallback.js';

test('extractWithPattern: recovers unit from full match when captured group is bare', () => {
  const r = extractWithPattern('Runware balance $4.10 remaining', 'balance \\$?(\\d+\\.\\d+)');
  assert.ok(r.ok);
  assert.equal(r.value, 4.1);
  assert.equal(r.unit, '$');
  assert.equal(r.kind, 'currency');
  assert.equal(r.matched, 'balance $4.10');
});

test('extractWithPattern: uses opts.unit when unit is still null and kind is not used-of-total', () => {
  const r = extractWithPattern('You have 1,200 credits left', 'have ([\\d,]+)', { unit: 'credits' });
  assert.ok(r.ok);
  assert.equal(r.value, 1200);
  assert.equal(r.unit, 'credits');
  assert.equal(r.kind, 'unit');
  assert.equal(r.matched, 'have 1,200');
});

test('extractWithPattern: does not override a unit found by parsing', () => {
  const r = extractWithPattern('balance $4.10', '(\\$\\d+\\.\\d+)', { unit: 'credits' });
  assert.ok(r.ok);
  assert.equal(r.value, 4.1);
  assert.equal(r.unit, '$');
  assert.equal(r.kind, 'currency');
});

test('extractWithPattern: does not apply opts.unit to used-of-total kind', () => {
  const r = extractWithPattern('used 2 of 5 GB', 'used (2 of 5 GB)', { unit: 'TB' });
  assert.ok(r.ok);
  assert.equal(r.value, 2);
  assert.equal(r.unit, 'GB');
  assert.equal(r.kind, 'used-of-total');
});

test('extractWithPattern: null opts leaves unit and kind unchanged (bare)', () => {
  const r = extractWithPattern('balance 4.10', 'balance \\$?(\\d+\\.\\d+)');
  assert.ok(r.ok);
  assert.equal(r.value, 4.1);
  assert.equal(r.unit, null);
  assert.equal(r.kind, 'bare');
});

test('readWithFallback: passes lastUnit into extractWithPattern', async () => {
  const result = await readWithFallback({
    text: '4.10',
    pattern: '(\\d+\\.\\d+)',
    settings: { emberEnabled: false, allowPageText: false },
    label: 'test',
    lastUnit: '$',
  });
  assert.ok(result.ok);
  assert.equal(result.source, 'pattern');
  assert.equal(result.parsed.value, 4.1);
  assert.equal(result.parsed.unit, '$');
  assert.equal(result.parsed.kind, 'currency');
});

test('readWithFallback: without lastUnit unit stays null', async () => {
  const result = await readWithFallback({
    text: '4.10',
    pattern: '(\\d+\\.\\d+)',
    settings: { emberEnabled: false, allowPageText: false },
    label: 'test',
  });
  assert.ok(result.ok);
  assert.equal(result.source, 'pattern');
  assert.equal(result.parsed.value, 4.1);
  assert.equal(result.parsed.unit, null);
  assert.equal(result.parsed.kind, 'bare');
});
