import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = new URL('./tmp-auth.db', import.meta.url).pathname;
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

  const next = await fetch(`${base}/api/stats`, { headers: { cookie: 'rk_token=sesam' } });
  assert.equal(next.status, 200);
});
