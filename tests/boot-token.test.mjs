//! Boot with a tokened URL. Its own file because there is one mount per
//! process — see tests/helpers/dom.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const app = await mount({ path: '/feed', search: '?token=hunter2&d=30' });

test('boot strips ?token= from the address bar', () => {
  // The token is a bootstrap: the server trades the first tokened request for
  // a year-long rk_token cookie, and every request after it rides on that.
  // Carrying the param onwards only stamps the shared secret into every
  // history entry and into anything copied out of the address bar.
  assert.equal(app.bootError, null);
  const [first] = app.history;
  assert.equal(first.type, 'replace', 'boot must not add a history entry');
  assert.ok(!first.url.includes('token'), `the token survived into ${first.url}`);
  assert.ok(first.url.includes('d=30'), 'and the real filters did not');
});
