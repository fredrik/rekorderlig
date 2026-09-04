//! The one fetch wrapper. A request that never answers must end in an error
//! the view can show, not a spinner that never stops.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../public/dom.js';

test('a request that never answers times out with a message', { timeout: 2000 }, async () => {
  // A fetch that resolves only by being aborted — the machine mid-suspend, a
  // socket that died. It honours the signal the way a browser does.
  globalThis.fetch = (_url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
  });
  // `AbortSignal.timeout` schedules an *unref'd* timer. A browser has a page
  // to keep the loop alive; here the fake fetch pends on nothing else, so Node
  // drains the loop and cancels the test before the deadline can fire. One
  // ref'd timer outliving the deadline stands in for the live page.
  const alive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(api('/api/round', { timeoutMs: 20 }), (err) => {
      assert.match(err.message, /no answer from the server/);
      return true;
    });
  } finally {
    clearTimeout(alive);
  }
});

test('a normal answer is unaffected by the deadline', async () => {
  globalThis.fetch = async (_url, opts) => {
    assert.ok(opts.signal instanceof AbortSignal, 'every request carries a deadline');
    assert.equal(opts.timeoutMs, undefined, 'the deadline is not handed to fetch as an option');
    return { ok: true, status: 200, json: async () => ({ fine: true }) };
  };
  assert.deepEqual(await api('/api/stats'), { fine: true });
});
