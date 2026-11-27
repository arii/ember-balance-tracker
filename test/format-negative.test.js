import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatValue } from '../src/lib/format.js';

test('currency negative sign before $', () => {
  assert.equal(formatValue({ value: -5.2, unit: '$' }), '-$5.20');
});

test('currency negative zero shows no minus', () => {
  assert.equal(formatValue({ value: -0, unit: '$' }), '$0.00');
});

test('currency small negative rounds to zero no minus', () => {
  assert.equal(formatValue({ value: -0.004, unit: '$' }), '$0.00');
});

test('non-currency small negative rounds to zero no minus', () => {
  assert.equal(formatValue({ value: -0.004, unit: 'credits' }), '0 credits');
});

test('percent negative zero no minus', () => {
  assert.equal(formatValue({ value: -0, unit: '%' }), '0%');
});

test('percent negative keeps minus', () => {
  assert.equal(formatValue({ value: -12, unit: '%' }), '-12%');
});

test('non-currency negative keeps minus', () => {
  assert.equal(formatValue({ value: -12, unit: 'credits' }), '-12 credits');
});

test('positive currency unchanged', () => {
  assert.equal(formatValue({ value: 6.9, unit: '$' }), '$6.90');
});

test('positive percent unchanged', () => {
  assert.equal(formatValue({ value: 69, unit: '%' }), '69%');
});

test('positive non-currency unchanged with separators', () => {
  assert.equal(formatValue({ value: 1500, unit: 'credits' }), '1,500 credits');
});

test('larger negative currency sign before $', () => {
  assert.equal(formatValue({ value: -1234.5, unit: '$' }), '-$1,234.50');
});

test('null returns no reading yet', () => {
  assert.equal(formatValue(null), 'No reading yet');
});
