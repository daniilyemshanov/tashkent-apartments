import test from 'node:test';
import assert from 'node:assert/strict';
import { runCleanup } from './daily-cleanup.mjs';

test('dry run calls the RPC once, with p_dry_run=true, and changes nothing', async () => {
  const calls = [];
  const rpc = async (args) => { calls.push(args); return { slimmed: 0, trimmed: 0, purged: 0, purge_candidates: 5 }; };
  const result = await runCleanup({ rpc, live: false, args: { p_keep_days: 14 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].p_dry_run, true);
  assert.equal(result.rounds, 1);
});

test('live run repeats until a round does no work, and sums the totals', async () => {
  const rounds = [
    { slimmed: 2000, trimmed: 0, purged: 2000 },
    { slimmed: 300, trimmed: 5, purged: 40 },
    { slimmed: 0, trimmed: 0, purged: 0 },
  ];
  const calls = [];
  const rpc = async (args) => { calls.push(args); return rounds[calls.length - 1]; };
  const result = await runCleanup({ rpc, live: true, args: {} });
  assert.equal(result.rounds, 3);
  assert.deepEqual(result.totals, { slimmed: 2300, trimmed: 5, purged: 2040 });
  assert.ok(calls.every((c) => c.p_dry_run === false));
});

test('live run stops at the round limit instead of looping forever', async () => {
  const rpc = async () => ({ slimmed: 1, trimmed: 0, purged: 0 });
  const result = await runCleanup({ rpc, live: true, args: {}, maxRounds: 4 });
  assert.equal(result.rounds, 4);
});
