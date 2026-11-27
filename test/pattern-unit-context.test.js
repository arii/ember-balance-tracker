import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithPattern } from '../src/lib/regexcheck.js';

test('context unit from full page text overrides opts.unit when value matches', () => {
  const r = extractWithPattern('You have 1,200 credits left', 'have ([\\d,]+)', { unit: '$' });
  assert.ok(r.ok);
  assert.equal(r.value, 1200);
  assert.equal(r.unit, 'credits');
  assert.equal(r.kind, 'unit');
});

test('used-of-total context blocks opts.unit inheritance', () => {
  const r = extractWithPattern('used 5 of 10', 'used (\\d+)', { unit: 'GB' });
  assert.ok(r.ok);
  assert.equal(r.value, 5);
  assert.equal(r.unit, null);
  assert.equal(r.kind, 'bare');
});

test('opts.unit inherited only when page text has no unit', () => {
  const r = extractWithPattern('12', '(\\d+)', { unit: '$' });
  assert.ok(r.ok);
  assert.equal(r.value, 12);
  assert.equal(r.unit, '$');
  assert.equal(r.kind, 'currency');
});

test('different unit on page prevents opts.unit', () => {
  const r = extractWithPattern('balance 500MB', '(\\d+)', { unit: 'GB' });
  assert.ok(r.ok);
  assert.equal(r.value, 500);
  assert.equal(r.unit, 'MB');
  assert.equal(r.kind, 'unit');
});
