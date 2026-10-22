import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const { editMessageText, answerCallbackQuery } = await import('./_telegramApi.js');

const originalFetch = globalThis.fetch;
const originalError = console.error;

afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
});

test('message is not modified is treated as a normal no-op without logging or retry', async () => {
  let requests = 0;
  let logs = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return {
      json: async () => ({
        ok: false,
        description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup',
      }),
    };
  };
  console.error = () => { logs += 1; };

  const result = await editMessageText(123, 456, 'same text');

  assert.equal(result.ok, false);
  assert.equal(requests, 1);
  assert.equal(logs, 0);
});

test('other Telegram API errors are still logged and are not retried', async () => {
  let requests = 0;
  const messages = [];
  globalThis.fetch = async () => {
    requests += 1;
    return {
      json: async () => ({ ok: false, description: 'Bad Request: message to edit not found' }),
    };
  };
  console.error = (...args) => { messages.push(args); };

  await editMessageText(123, 456, 'new text');

  assert.equal(requests, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0].join(' '), /message to edit not found/);
});


test('expired callback IDs are treated as expected and are not retried', async () => {
  let requests = 0;
  let logs = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return {
      ok: true,
      json: async () => ({
        ok: false,
        description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
      }),
    };
  };
  console.error = () => { logs += 1; };
  const result = await answerCallbackQuery('expired-callback-id');
  assert.equal(result.ok, false);
  assert.equal(requests, 1);
  assert.equal(logs, 0);
});

test('callback acknowledgement is issued as one API call', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  await answerCallbackQuery('valid-callback-id');
  assert.equal(requests, 1);
});
