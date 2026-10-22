import { test } from 'node:test';
import assert from 'node:assert/strict';
import { throwOnSupabaseError } from './_dbErrors.js';

test('database errors are logged and propagated instead of silently swallowed', () => {
  const oldError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    assert.throws(
      () => throwOnSupabaseError('getSession', { message: 'schema cache unavailable' }),
      /getSession.*schema cache unavailable/
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0].join(' '), /schema cache unavailable/);
  } finally {
    console.error = oldError;
  }
});

test('no database error is a no-op', () => {
  assert.equal(throwOnSupabaseError('getSession', null), undefined);
});
