import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatValue, relativeTime, formatMeta, titleFor } from '../src/lib/format.js';

test('formatValue handles currency', () => {
  assert.equal(formatValue({ value: 6.9, unit: '$' }), '$6.90');
  assert.equal(formatValue({ value: 1234.5, unit: '$' }), '$1,234.50');
  assert.equal(formatValue({ value: 0, unit: '$' }), '$0.00');
});

test('formatValue handles percent', () => {
  assert.equal(formatValue({ value: 69, unit: '%' }), '69%');
  assert.equal(formatValue({ value: 69.5, unit: '%' }), '69.5%');
});

test('formatValue handles unit words', () => {
  assert.equal(formatValue({ value: 1500, unit: 'credits' }), '1,500 credits');
  assert.equal(formatValue({ value: 12, unit: 'points' }), '12 points');
});

test('formatValue handles thousands separators', () => {
  assert.equal(formatValue({ value: 1234567, unit: null }), '1,234,567');
  assert.equal(formatValue({ value: 1234.5, unit: 'GB' }), '1,234.5 GB');
});

test('formatValue handles null/undefined/NaN', () => {
  assert.equal(formatValue(null), 'No reading yet');
  assert.equal(formatValue(undefined), 'No reading yet');
  assert.equal(formatValue({ value: NaN, unit: '$' }), 'No reading yet');
  assert.equal(formatValue({ value: undefined, unit: '%' }), 'No reading yet');
});

test('formatValue handles no history', () => {
  assert.equal(formatValue(undefined), 'No reading yet');
});

test('relativeTime buckets', () => {
  const now = 1_700_000_000_000;
  assert.equal(relativeTime(now, now), 'just now');
  assert.equal(relativeTime(now - 30_000, now), 'just now');
  assert.equal(relativeTime(now - 60_000, now), '1 min ago');
  assert.equal(relativeTime(now - 5 * 60_000, now), '5 min ago');
  assert.equal(relativeTime(now - 60 * 60_000, now), '1 h ago');
  assert.equal(relativeTime(now - 3 * 60 * 60_000, now), '3 h ago');
  assert.equal(relativeTime(now - 24 * 60 * 60_000, now), new Date(now - 24 * 60 * 60_000).toLocaleDateString());
});

test('formatMeta returns relative time or never read', () => {
  const t = { anchor: 'balance', history: [{ ts: Date.now() - 5 * 60_000 }] };
  assert.equal(formatMeta(t), '5 min ago');
  assert.equal(formatMeta({ history: [] }), 'never read');
  assert.equal(formatMeta({}), 'never read');
});

test('titleFor includes url, source, absolute time, rule status', () => {
  const t = {
    urlPattern: 'https://example.com',
    history: [{ ts: 1_700_000_000_000, source: 'dom' }],
    pattern: 'regex',
  };
  const title = titleFor(t);
  assert.ok(title.includes('URL: https://example.com'));
  assert.ok(title.includes('Source: dom'));
  assert.ok(title.includes('Last read: '));
  assert.ok(title.includes('Ember rule: ✓'));
});
