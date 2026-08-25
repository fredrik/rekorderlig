import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = new URL('./data/tmp-auth.db', import.meta.url).pathname;
rmSync(DB, { force: true });
process.env.REKORDERLIG_DB = DB;
process.env.NODE_ENV = 'test';
process.env.AUTH_TOKEN = 'sesam';

const { server, conn } = await import('../src/server.js');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => {
  server.close();
  conn.close();
  rmSync(DB, { force: true });
  delete process.env.AUTH_TOKEN;
});

test('requests without the token are rejected', async () => {
  assert.equal((await fetch(`${base}/`)).status, 401);
  assert.equal((await fetch(`${base}/api/stats`)).status, 401);
  assert.equal((await fetch(`${base}/api/stats?token=wrong`)).status, 401);
});

test('a malformed cookie is a 401, not a crash', async () => {
  const res = await fetch(`${base}/api/stats`, { headers: { cookie: 'rk_token=%E0; junk; a=b=c' } });
  assert.equal(res.status, 401);
  // the server is still alive
  assert.equal((await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer sesam' } })).status, 200);
});

test('a bearer header is accepted', async () => {
  const res = await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer sesam' } });
  assert.equal(res.status, 200);
});

test('?token=… works once and sets a cookie for the rest', async () => {
  const first = await fetch(`${base}/?token=sesam`, { redirect: 'manual' });
  assert.equal(first.status, 200);
  const cookie = first.headers.get('set-cookie');
  assert.match(cookie, /rk_token=sesam/);
  assert.match(cookie, /HttpOnly/);
  assert.doesNotMatch(cookie, /Secure/, 'plain http must be able to store the cookie');

  const viaProxy = await fetch(`${base}/?token=sesam`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(viaProxy.headers.get('set-cookie'), /Secure/);

  const next = await fetch(`${base}/api/stats`, { headers: { cookie: 'rk_token=sesam' } });
  assert.equal(next.status, 200);
});
