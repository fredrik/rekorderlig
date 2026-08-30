//! Boot when the cookie did not take. Its own file: one mount per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const app = await mount({ path: '/feed', search: '?token=hunter2', statsFails: true });

test('a token is left in the bar until the cookie is proven', () => {
  // Stripping is only safe because it happens after an authorized fetch that
  // carried no token of its own: /api/stats sends neither a param nor a Bearer
  // header, so reaching the rewrite proves the cookie took. When it 401s,
  // `api()` throws, the rewrite never runs, and the tokened URL stays good for
  // a reload — the recovery the 401 body itself names.
  //
  // The tripwire this replaced could only assert which line came first.
  assert.ok(app.bootError, 'boot should not survive an unauthorized stats call');
  assert.deepEqual(app.history, [], 'nothing may rewrite the URL before the cookie is proven');
});
