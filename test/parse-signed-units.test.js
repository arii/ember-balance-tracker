import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance } from '../src/lib/parse.js';

test('negative numbers before unit words are parsed as negative', () => {
  assert.deepEqual(parseBalance('Balance: -12 credits'), { ok: true, value: -12, unit: 'credits', raw: 'Balance: -12 credits', kind: 'unit' });
  assert.deepEqual(parseBalance('-3.5 credits'), { ok: true, value: -3.5, unit: 'credits', raw: '-3.5 credits', kind: 'unit' });
  assert.deepEqual(parseBalance('Overdrawn: -20%'), { ok: true, value: -20, unit: '%', raw: 'Overdrawn: -20%', kind: 'unit' });
  assert.deepEqual(parseBalance('(-5 credits)'), { ok: true, value: -5, unit: 'credits', raw: '(-5 credits)', kind: 'unit' });
  assert.deepEqual(parseBalance('Usage: -1,000 tokens'), { ok: true, value: -1000, unit: 'tokens', raw: 'Usage: -1,000 tokens', kind: 'unit' });
});

test('keep identifiers and ranges positive', () => {
  assert.deepEqual(parseBalance('AC-8812 credits'), { ok: true, value: 8812, unit: 'credits', raw: 'AC-8812 credits', kind: 'unit' });
  assert.deepEqual(parseBalance('Range 5-10 credits'), { ok: true, value: 10, unit: 'credits', raw: 'Range 5-10 credits', kind: 'unit' });
  assert.deepEqual(parseBalance('Balance - 12 credits'), { ok: true, value: 12, unit: 'credits', raw: 'Balance - 12 credits', kind: 'unit' });
  assert.deepEqual(parseBalance('2024-12 credits'), { ok: true, value: 12, unit: 'credits', raw: '2024-12 credits', kind: 'unit' });
  assert.deepEqual(parseBalance('order#-55 points'), { ok: true, value: 55, unit: 'points', raw: 'order#-55 points', kind: 'unit' });
  assert.deepEqual(parseBalance('Plan A-1 credits 500'), { ok: true, value: 1, unit: 'credits', raw: 'Plan A-1 credits 500', kind: 'unit' });
});

test('non-regression for existing positive unit parsing', () => {
  assert.deepEqual(parseBalance('4,000 credits'), { ok: true, value: 4000, unit: 'credits', raw: '4,000 credits', kind: 'unit' });
  assert.deepEqual(parseBalance('127 CR'), { ok: true, value: 127, unit: 'CR', raw: '127 CR', kind: 'unit' });
  assert.deepEqual(parseBalance('12.5 hrs'), { ok: true, value: 12.5, unit: 'hrs', raw: '12.5 hrs', kind: 'unit' });
});

test('number glued to a word character still parses (no regression)', () => {
  assert.equal(parseBalance('x500 credits').value, 500);
});

test('space-separated range "5 -10 credits" is not a negative amount', () => {
  assert.equal(parseBalance('5 -10 credits').value, 10);
  assert.equal(parseBalance('Balance: -10 credits').value, -10);
});
