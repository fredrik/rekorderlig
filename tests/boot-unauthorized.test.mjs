//! Boot when the session is gone. Its own file: one mount per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const app = await mount({ path: '/feed', search: '?d=30', statsFails: true });

test('a dead session stops the boot and says so', () => {
  // index.html is only served to a live session, so this is the case where
  // the session died between the page load and its first request. Nothing
  // below the stats call can work, so boot stops — and says where the eye
  // already is what to do about it. The URL is left alone: there is nothing
  // to normalise on a page that is not going to run.
  assert.ok(app.bootError, 'boot should not survive an unauthorized stats call');
  assert.match(app.text('#tagline'), /login link/);
  assert.deepEqual(app.history, [], 'nothing may rewrite the URL on a failed boot');
});
