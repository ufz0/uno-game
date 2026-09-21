import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.PORT = '0';

const mod = await import('../server.js');
const { server } = mod;
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

after(() => new Promise((r) => server.close(r)));

test('GET /api/health reports ok', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET / serves the game page', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /the card table/);
});

test('static assets (app.js, style.css) are served', async () => {
  for (const p of ['/app.js', '/style.css']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 200, `${p} should be served`);
    assert.ok((await res.text()).length > 0, `${p} is not empty`);
  }
});

test('security headers are set on the API response', async () => {
  const res = await fetch(`${base}/api/health`);
  const h = res.headers;
  assert.match(h.get('content-security-policy') || '', /default-src 'self'/);
  assert.match(h.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(h.get('x-frame-options'), 'DENY');
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.equal(h.get('referrer-policy'), 'no-referrer');
  assert.equal(h.get('x-powered-by'), null, 'X-Powered-By is disabled');
});

test('security headers are set on the served page and static assets', async () => {
  for (const p of ['/', '/app.js', '/style.css']) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 200, `${p} should be served`);
    const h = res.headers;
    assert.match(h.get('content-security-policy') || '', /frame-ancestors 'none'/, `${p}: CSP`);
    assert.equal(h.get('x-frame-options'), 'DENY', `${p}: X-Frame-Options`);
    assert.equal(h.get('x-content-type-options'), 'nosniff', `${p}: nosniff`);
    assert.equal(h.get('x-powered-by'), null, `${p}: X-Powered-By disabled`);
  }
});

test('unknown routes and missing files 404', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404, 'unknown API route');
  assert.equal((await fetch(`${base}/definitely-not-a-file.js`)).status, 404, 'missing static file');
});
