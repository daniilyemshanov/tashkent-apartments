import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishedAt } from '../../scraper/src/publicationDate.js';

const now = new Date('2026-10-31T10:00:00Z');

test('parses unambiguous ISO timestamps and dates', () => {
  assert.equal(parsePublishedAt('2026-10-30T12:00:00Z', now), '2026-10-30T12:00:00.000Z');
  assert.equal(parsePublishedAt('2026-10-30', now), '2026-10-29T19:00:00.000Z');
});

test('parses Uzbekistan local dates and relative dates in Tashkent time', () => {
  assert.equal(parsePublishedAt('30.10.2026 12:30', now), '2026-10-30T07:30:00.000Z');
  assert.equal(parsePublishedAt('вчера', now), '2026-10-29T19:00:00.000Z');
  assert.equal(parsePublishedAt('вчера в 12:00', now), '2026-10-30T07:00:00.000Z');
  assert.equal(parsePublishedAt('2 дня назад', now), '2026-10-28T19:00:00.000Z');
});

test('keeps missing, unknown, invalid, ambiguous, and unsupported dates null', () => {
  for (const value of [null, '', 'неизвестно', '31.02.2026', '10/11/2026', 'July 10', 'вчера в 25:00']) {
    assert.equal(parsePublishedAt(value, now), null, String(value));
  }
});
