import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDuplicateUpdate } from './_updateDedupe.js';

test('duplicate webhook update IDs are skipped within the dedupe window', () => {
  const id = `test-${Date.now()}-${Math.random()}`;
  assert.equal(isDuplicateUpdate(id, 1000), false);
  assert.equal(isDuplicateUpdate(id, 1001), true);
});

test('expired dedupe entries can be processed again', () => {
  const id = `expiry-${Date.now()}-${Math.random()}`;
  assert.equal(isDuplicateUpdate(id, 1000), false);
  assert.equal(isDuplicateUpdate(id, 1000 + 10 * 60 * 1000 + 1), false);
});
