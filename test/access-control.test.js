const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const { AccessControl } = require('../lib/access-control');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('generated operator passwords are independent, hashed, and revocable', () => {
  const db = new Database(':memory:');
  try {
    const access = new AccessControl(db, 'test-only-master');
    assert.throws(() => access.create('  '), /备注/);
    assert.throws(() => access.create('x'.repeat(61)), /备注/);
    const first = access.create('First AI');
    const second = access.create('Second AI');
    assert.notEqual(first.password, second.password);
    const stored = db.prepare('SELECT * FROM operator_passwords').all();
    assert.equal(stored[0].secret_hash.length, 64);
    assert.ok(!JSON.stringify(stored).includes(first.password));
    assert.ok(!JSON.stringify(access.list()).includes('secret_hash'));
    const identity = access.authenticate(first.password);
    assert.equal(identity.role, 'operator');
    assert.ok(access.list().find(row => row.id === first.id).last_used_at);
    access.revoke(first.id);
    access.revoke(first.id);
    assert.equal(access.authenticate(first.password), null);
    assert.equal(access.isActive(identity), false);
    assert.equal(access.authenticate(second.password).role, 'operator');
    assert.equal(access.authenticate('test-only-master').role, 'admin');
    assert.equal(new AccessControl(db, '').authenticate(second.password), null);
  } finally { db.close(); }
});

async function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'snowmail-auth-'));
  const project = path.resolve(__dirname, '..');
  const adminKey = crypto.randomBytes(32).toString('hex');
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit');
    child.kill();
    await ended;
  }
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: project, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, API_KEY: adminKey, API_PORT: String(port), API_HOST: '127.0.0.1',
        DATA_DIR: folder, MAIL_DOMAIN: 'example.test', MAIL_DOMAINS: 'example.test', DEFAULT_MAIL_DOMAIN: 'example.test',
        SMTP_ENABLED: 'true', SMTP_PORT: '0', AMELU_SECRET_KEY: '', RETENTION_HOURS: '48' },
    });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/health`)).ok) return; } catch {}
      if (child.exitCode !== null) throw new Error('Isolated test server exited');
      await pause(50);
    }
    throw new Error('Isolated test server did not start');
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(folder).startsWith('snowmail-auth-'));
    fs.rmSync(folder, { recursive: true, force: true });
  });
  await start();
  async function request(route, { key, cookie, method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + route, {
      method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { request, adminKey, folder, restart: async () => { await stop(); await start(); } };
}

test('real server enforces operator scope through API keys and browser sessions', async t => {
  const f = await fixture(t);
  const { request, adminKey } = f;
  let first, second, adminCookie, operatorCookie, address, emailId;

  await t.test('existing master password still controls administration', async () => {
    assert.equal((await request('/api/admin/access-passwords')).status, 401);
    assert.equal((await request('/api/admin/login', { method: 'POST', body: { password: 'wrong' } })).status, 401);
    const login = await request('/api/admin/login', { method: 'POST', body: { password: adminKey } });
    assert.equal(login.data.role, 'admin');
    adminCookie = login.cookie;
    assert.equal((await request('/admin', { cookie: adminCookie })).status, 200);
    const created = await request('/api/admin/access-passwords', { cookie: adminCookie, method: 'POST', body: { label: 'Development AI' } });
    assert.equal(created.status, 201);
    first = created.data;
    second = (await request('/api/admin/access-passwords', { key: adminKey, method: 'POST', body: { label: 'Other AI' } })).data;
    const listed = await request('/api/admin/access-passwords', { key: adminKey });
    assert.equal(listed.data.passwords.length, 2);
    assert.ok(!JSON.stringify(listed.data).includes(first.password));
    assert.ok(!JSON.stringify(listed.data).includes('secret_hash'));
  });

  await t.test('operator can sign in without gaining master privileges', async () => {
    const login = await request('/api/admin/login', { method: 'POST', body: { password: first.password, role: 'admin' } });
    assert.equal(login.status, 200);
    assert.equal(login.data.role, 'operator');
    operatorCookie = login.cookie;
    const session = await request('/api/admin/session', { cookie: operatorCookie });
    assert.equal(session.data.role, 'operator');
    assert.ok(!session.data.permissions.includes('*'));
    assert.equal((await request('/admin', { cookie: operatorCookie })).status, 200);
    assert.equal((await request('/api/config', { headers: { 'x-api-key': first.password } })).status, 200);
    assert.equal((await request('/api/config', { key: first.password })).status, 200);
  });

  await t.test('operator can create and inspect mailboxes and read message content', async () => {
    const created = await request('/api/generate', { key: first.password, method: 'POST', body: { custom: 'operator-test', domain: 'example.test', retention_hours: 24 } });
    assert.equal(created.status, 200);
    address = created.data.address;
    const ingest = await request('/api/ingest', { key: adminKey, method: 'POST', body: {
      recipient: address, sender: 'fixture@example.test', subject: 'Fixture', body_text: 'Verification body', raw_source: 'Subject: Fixture\r\n\r\nVerification body',
    } });
    assert.equal(ingest.status, 200);
    assert.equal((await request('/api/mailboxes', { cookie: operatorCookie })).data.mailboxes.length, 1);
    const mail = await request(`/api/mailbox/${address}`, { key: first.password });
    emailId = mail.data.emails[0].id;
    assert.equal((await request(`/api/email/${emailId}`, { key: first.password })).data.body_text, 'Verification body');
    assert.equal((await request(`/api/email/${emailId}/raw`, { key: first.password })).status, 200);
    assert.equal((await request(`/api/mailbox/${address}/latest`, { key: first.password })).data.id, emailId);
    assert.equal((await request(`/api/mailbox/${address}/wait?timeout=1&since=2000-01-01`, { cookie: operatorCookie })).data.id, emailId);
    assert.equal((await request('/api/stats', { key: first.password })).status, 200);
    assert.equal((await request('/api/addresses', { key: first.password })).status, 200);
  });

  await t.test('every administrative endpoint denies both operator transports', async () => {
    const routes = [
      ['GET', '/api/admin/access-passwords'], ['POST', '/api/admin/access-passwords'],
      ['DELETE', `/api/admin/access-passwords/${second.id}`], ['POST', '/api/ingest'], ['DELETE', `/api/email/${emailId}`],
      ['GET', '/api/amelu/connections'], ['POST', '/api/amelu/discover'], ['POST', '/api/amelu/inspect'],
      ['POST', '/api/amelu/connections'], ['POST', '/api/amelu/connections/fake/sync'], ['PATCH', '/api/amelu/connections/fake'],
      ['GET', '/api/amelu/pending'], ['POST', '/api/amelu/pending/1/assign'], ['DELETE', '/api/amelu/pending/1'],
    ];
    for (const credential of [{ key: first.password }, { cookie: operatorCookie }]) {
      for (const [method, route] of routes) {
        assert.equal((await request(route, { ...credential, method })).status, 403, `${method} ${route}`);
      }
    }
  });

  await t.test('explicit limited or invalid keys cannot borrow an admin cookie', async () => {
    assert.equal((await request('/api/admin/access-passwords', { cookie: adminCookie, key: first.password })).status, 403);
    assert.equal((await request('/api/admin/access-passwords', { cookie: adminCookie, key: 'invalid' })).status, 401);
    assert.equal((await request('/api/admin/access-passwords', { cookie: adminCookie, headers: { Authorization: 'Bearer ' } })).status, 401);
    assert.equal((await request('/api/config', { cookie: 'snowmail_admin_session=%invalid' })).status, 401);
  });

  await t.test('revocation cancels existing sessions and in-flight mail waits', async () => {
    const waiting = request(`/api/mailbox/${address}/wait?timeout=5&since=2099-01-01`, { key: first.password });
    const browserWaiting = request(`/api/mailbox/${address}/wait?timeout=5&since=2099-01-01`, { cookie: operatorCookie });
    await pause(150);
    assert.equal((await request(`/api/admin/access-passwords/${first.id}`, { key: adminKey, method: 'DELETE' })).status, 200);
    assert.equal((await waiting).status, 401);
    assert.equal((await browserWaiting).status, 401);
    assert.equal((await request('/api/config', { key: first.password })).status, 401);
    assert.equal((await request('/api/config', { cookie: operatorCookie })).status, 401);
    assert.equal((await request('/api/admin/login', { method: 'POST', body: { password: first.password } })).status, 401);
    assert.equal((await request('/admin', { cookie: operatorCookie })).status, 302);
    assert.equal((await request('/api/config', { key: second.password })).status, 200);
    assert.equal((await request('/api/admin/access-passwords', { cookie: adminCookie })).status, 200);
    assert.equal((await request(`/api/email/${emailId}`, { key: second.password })).status, 200);
  });

  await t.test('operator passwords and revocations survive service restarts', async () => {
    await f.restart();
    assert.equal((await request('/api/config', { key: second.password })).status, 200);
    assert.equal((await request('/api/config', { key: first.password })).status, 401);
    assert.equal((await request('/api/admin/access-passwords', { key: adminKey })).status, 200);
  });

  await t.test('operator can delete mailboxes using both existing routes', async () => {
    assert.equal((await request(`/api/mailboxes/${address}`, { key: second.password, method: 'DELETE' })).status, 200);
    assert.equal((await request(`/api/email/${emailId}`, { key: adminKey })).status, 404);
    assert.equal((await request('/api/mailboxes', { key: second.password })).data.mailboxes.length, 0);
    const generated = await request('/api/generate', { key: second.password });
    assert.equal(generated.status, 200);
    assert.equal((await request(`/api/mailbox/${generated.data.address}`, { key: second.password, method: 'DELETE' })).status, 200);
  });

  await t.test('supports 35 concurrent mailbox creations in one burst without rate limiting or collisions', async () => {
    const burst = await Promise.all(
      Array.from({ length: 35 }, () =>
        request('/api/generate', {
          key: second.password,
          method: 'POST',
          body: { domain: 'example.test', retention_hours: 24 },
        })
      )
    );
    assert.ok(burst.every(res => res.status === 200));
    const uniqueAddresses = new Set(burst.map(res => res.data.address));
    assert.equal(uniqueAddresses.size, 35);
    for (const addr of uniqueAddresses) {
      const local = addr.split('@')[0];
      assert.match(local, /[a-z0-9]{4}$/, `expected high-entropy suffix on ${addr}`);
    }
  });

  await t.test('rejects URL query key, blocks cross-origin cookie CSRF, sets CSP/HSTS headers, hides Express fingerprint, and throttles brute-force guesses', async () => {
    const plainHealth = await request('/api/health');
    assert.equal(plainHealth.status, 200);
    assert.equal(plainHealth.headers.get('x-powered-by'), null);
    assert.equal(plainHealth.headers.get('strict-transport-security'), null);

    const httpsHealth = await request('/api/health', {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(httpsHealth.status, 200);
    assert.equal(httpsHealth.headers.get('x-powered-by'), null);
    assert.equal(httpsHealth.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.ok(httpsHealth.headers.get('content-security-policy')?.includes("default-src 'self'"));

    // URL ?key= must not authenticate
    assert.equal((await request(`/api/config?key=${encodeURIComponent(adminKey)}`)).status, 401);

    // Cross-origin state-changing request using browser session cookie must be rejected
    assert.equal(
      (await request('/api/generate', {
        cookie: adminCookie,
        method: 'POST',
        headers: { Origin: 'https://evil.attacker.invalid' },
        body: { domain: 'example.test' },
      })).status,
      401
    );

    // Brute-force guesses from an attacker IP get throttled with 429 after 15 failures
    const attackerHeaders = { 'CF-Connecting-IP': '203.0.113.99' };
    for (let i = 0; i < 15; i += 1) {
      const attempt = await request('/api/admin/login', {
        method: 'POST',
        headers: attackerHeaders,
        body: { password: `wrong-guess-${i}` },
      });
      assert.equal(attempt.status, 401);
    }
    const throttled = await request('/api/admin/login', {
      method: 'POST',
      headers: attackerHeaders,
      body: { password: adminKey },
    });
    assert.equal(throttled.status, 429);

    // Valid automation from normal IP remains completely unaffected
    assert.equal((await request('/api/mailboxes', { key: second.password })).status, 200);
  });
});
