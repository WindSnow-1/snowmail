'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Amelu, routeMessage, secretBox } = require('../lib/amelu');

function fixture(t, { key = 'amelu_mock_test_key_not_real', domain = 'mail.example', domainId = 'domain-1' } = {}) {
  const db = new Database(':memory:');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  db.exec(source.match(/db\.exec\(`([\s\S]*?)`\);/)[1]);
  const remote = { catchall: '', mailboxes: [], messages: [], calls: [], failCatchall: false, failDetail: false,
    detailRequests: 0, readStatus: 200, missing: new Set() };
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const transport = async (url, options = {}) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname;
    const method = options.method || 'GET';
    remote.calls.push({ endpoint, method, query: parsed.search, body: options.body ? JSON.parse(options.body) : undefined });
    assert.equal(options.redirect, 'error');
    assert.equal(parsed.origin, 'https://api.amelu.org', 'all operations must use the API, never mailbox login');
    if (options.headers.Authorization !== `Bearer ${key}`) return reply({ error:'invalid API key' }, 401);
    if (endpoint === '/api/domains') return reply([{ id:domainId, name:domain, status:'active' }]);
    if (endpoint.startsWith(`/api/domains/${domainId}/`)) {
      if (endpoint.endsWith('/dns')) return reply({ records:[{ type:'MX', name:domain, status:'matched' }] });
      if (endpoint.endsWith('/aliases')) return reply([{ address:'alias@' + domain }]);
      if (endpoint.endsWith('/catchall')) {
        if (method === 'PUT') {
          if (remote.failCatchall) { remote.failCatchall = false; return reply({ error:'failure' }, 500); }
          remote.catchall = JSON.parse(options.body).address;
        }
        return reply(remote.catchall ? { address:remote.catchall } : {});
      }
      if (endpoint.endsWith('/mailboxes')) {
        if (method === 'POST') {
          const body = JSON.parse(options.body);
          assert.equal(Object.hasOwn(body, 'password'), false);
          const mailbox = { id:domainId + '-box-' + (remote.mailboxes.length + 1), address:body.localPart + '@' + domain };
          remote.mailboxes.push(mailbox);
          return reply(mailbox, 201);
        }
        return reply(remote.mailboxes);
      }
    }
    const mailboxId = decodeURIComponent(endpoint.split('/')[3] || '');
    if (remote.mailboxes.some(m => m.id === mailboxId) && endpoint.startsWith('/api/mailboxes/')) {
      assert.equal(method, 'GET');
      if (remote.readStatus !== 200) return reply({ error:'upstream secret must not be disclosed' }, remote.readStatus);
      if (endpoint.endsWith('/messages')) {
        assert.equal(parsed.searchParams.get('folder'), 'inbox');
        const position = Number(parsed.searchParams.get('position'));
        const limit = Number(parsed.searchParams.get('limit'));
        const sorted = remote.messages.slice().sort((a,b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
        return reply(remote.badList || { messages:sorted.slice(position, position + limit).map(m => ({ id:m.id, receivedAt:m.receivedAt })), total:sorted.length, position });
      }
      if (endpoint.includes('/messages/')) {
        remote.detailRequests++;
        if (remote.onDetail) await remote.onDetail();
        if (remote.failDetail) { remote.failDetail = false; return reply({ error:'failure' }, 500); }
        const id = decodeURIComponent(endpoint.split('/').pop());
        const found = remote.messages.find(m => m.id === id);
        if (!found || remote.missing.has(id)) return reply({ error:'deleted' }, 404);
        return reply(remote.badDetail || found);
      }
    }
    throw new Error('Unexpected request ' + method + ' ' + url);
  };
  const amelu = new Amelu({ db, dataDir:os.tmpdir(), secretKey:crypto.randomBytes(32).toString('hex'), fetchImpl:transport });
  t.after(async () => { await amelu.stop(); db.close(); });
  return { db, amelu, remote, key, domain, domainId };
}

async function connect(f, overrides = {}) {
  const draft = await f.amelu.discover(f.key);
  return f.amelu.connect({ token:draft.token, domainId:f.domainId, expectedCatchall:f.remote.catchall,
    confirmSetup:true, routing:'review', ...overrides });
}
function prepareMailbox(f, name = 'alice@mail.example') {
  f.db.prepare("INSERT OR IGNORE INTO mailboxes(address,created_at,expires_at) VALUES (?,'2020-01-01 00:00:00',NULL)").run(name);
  f.db.prepare("UPDATE amelu_connections SET created_at='2020-01-01T00:00:00.000Z'").run();
}
function message(id, target = 'alice@mail.example', fields = {}) {
  return { id, from:[{ email:'sender@example.com' }], to:[{ email:target }], subject:'Test ' + id,
    receivedAt:new Date(Date.now() - 5000).toISOString(), textBody:'Hello ' + id, htmlBody:'<p>Hello ' + id + '</p>', ...fields };
}

test('AES-GCM encrypts credentials and rejects tampering or a lost key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowmail-key-'));
  try {
    const keyPath = path.join(dir, '.amelu-key');
    const box = secretBox(keyPath, undefined, false);
    const secret = box.encrypt({ key:'private-value', password:'private-password' });
    assert.ok(!secret.includes('private-value'));
    assert.deepEqual(box.decrypt(secret), { key:'private-value', password:'private-password' });
    const bytes = Buffer.from(secret, 'base64'); bytes[30] ^= 1;
    assert.throws(() => box.decrypt(bytes.toString('base64')), /无法解密/);
    fs.unlinkSync(keyPath);
    assert.throws(() => secretBox(keyPath, undefined, true), /missing/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('untrusted headers stay private by default, ambiguous recipients never fan out', () => {
  const c = { domain:'mail.example', mailbox_address:'catch@mail.example', routing:'review' };
  assert.equal(routeMessage(message('1'), c, () => true).recipient, null);
  c.routing = 'headers';
  assert.equal(routeMessage(message('1'), c, () => true).recipient, 'alice@mail.example');
  assert.equal(routeMessage(message('2', 'external@example.com', { bcc:[{ email:'alice@mail.example' }] }), c, () => true).recipient, 'alice@mail.example');
  assert.equal(routeMessage(message('3', 'alice@mail.example', { cc:[{ email:'bob@mail.example' }] }), c, () => true).recipient, null);
  assert.equal(routeMessage(message('4', 'external@example.com'), c, () => true).recipient, null);
});

test('connection requires confirmation, preserves existing catch-all, keeps secrets off responses', async t => {
  const f = fixture(t);
  await assert.rejects(connect(f, { confirmSetup:false }), /确认/);
  await assert.rejects(connect(f, { routing:'headers' }), /确认/);
  assert.equal(f.remote.mailboxes.length, 0);
  const c = await connect(f);
  assert.equal(c.enabled, 1);
  assert.equal(f.remote.mailboxes.length, 1);
  assert.ok(!JSON.stringify(f.amelu.list()).includes('amelu_mock_test_key'));
  assert.equal(f.amelu.reserved('alias@mail.example'), true);
  const calls = f.remote.calls.filter(c => c.method === 'PUT').length;
  await connect(f);
  assert.equal(f.remote.mailboxes.length, 1);
  assert.equal(f.remote.calls.filter(c => c.method === 'PUT').length, calls);
});

test('partial setup can be retried without creating another mailbox', async t => {
  const f = fixture(t);
  f.remote.failCatchall = true;
  await assert.rejects(connect(f), /500/);
  assert.equal(f.remote.mailboxes.length, 1);
  assert.equal(f.amelu.list()[0].status, 'setup');
  const c = await connect(f);
  assert.equal(c.enabled, 1);
  assert.equal(f.remote.mailboxes.length, 1);
});

test('existing catch-all connects with API key alone, without remote writes or stored mailbox credentials', async t => {
  const f = fixture(t);
  f.remote.catchall = 'existing@mail.example';
  f.remote.mailboxes = [{ id:'existing', address:f.remote.catchall }];
  f.remote.messages = [message('existing-mail')];
  const draft = await f.amelu.discover(f.key);
  assert.equal(Object.hasOwn(await f.amelu.inspect(draft.token, f.domainId), 'needsPassword'), false);
  const c = await connect(f);
  assert.equal(c.status, 'ready');
  assert.equal(f.remote.detailRequests, 1, 'connection verifies body access as well as the list');
  const saved = f.db.prepare('SELECT secret FROM amelu_connections').get();
  assert.deepEqual(f.amelu.getBox().decrypt(saved.secret), { key:f.key, transport:'api' });
  await assert.rejects(connect(f, { expectedCatchall:'other@mail.example' }), /已改变/);
  assert.equal(f.remote.calls.filter(c => c.method !== 'GET').length, 0);
  f.remote.catchall = 'outside@another.example';
  await assert.rejects(connect(f), /外部地址或别名/);
  assert.equal(f.remote.mailboxes.length, 1);
});

test('API sync imports decoded bodies, persists deduplication after deletion, reports unavailable original source', async t => {
  const f = fixture(t);
  const c = await connect(f, { routing:'headers', acceptHeaderRisk:true });
  prepareMailbox(f);
  f.remote.messages = [message('a'), message('b', 'external@example.com', { cc:[{ email:'alice@mail.example' }] })];
  const [first, concurrent] = await Promise.all([f.amelu.sync(c.id), f.amelu.sync(c.id)]);
  assert.equal(first.imported, 2); assert.deepEqual(first, concurrent);
  const emails = f.db.prepare('SELECT * FROM emails ORDER BY id').all();
  assert.equal(emails[1].body_text, 'Hello b');
  assert.equal(emails[1].body_html, '<p>Hello b</p>');
  await assert.rejects(f.amelu.raw(emails[0].id), error => error.status === 501 && /API.*原始邮件/.test(error.message));
  f.db.prepare('DELETE FROM emails').run();
  f.db.prepare("UPDATE amelu_connections SET scan_position=0,scan_until=NULL").run();
  await f.amelu.sync(c.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0);
  assert.equal(f.remote.detailRequests, 2);
});

test('default routing quarantines messages, assignment checks address lifecycle', async t => {
  const f = fixture(t);
  const c = await connect(f);
  prepareMailbox(f);
  f.remote.messages = [message('a'), message('b')];
  const result = await f.amelu.sync(c.id);
  assert.equal(result.pending, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0);
  const pending = f.amelu.pending();
  assert.throws(() => f.amelu.assign(pending[0].id, 'stranger@other.example'), /同域名/);
  f.amelu.assign(pending[0].id, 'alice@mail.example');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 1);
  f.amelu.deleted('alice@mail.example');
  assert.throws(() => f.amelu.assign(pending[1].id, 'alice@mail.example'), /同域名/);
  f.amelu.created('alice@mail.example');
  assert.throws(() => f.amelu.assign(pending[1].id, 'alice@mail.example'), /同域名/);
});

test('pagination, transient read failure, catch-all changes and pause do not lose or misroute mail', async t => {
  const f = fixture(t);
  const c = await connect(f, { routing:'headers', acceptHeaderRisk:true });
  prepareMailbox(f);
  f.remote.messages = Array.from({ length:56 }, (_, i) => message('id-' + i));
  f.remote.failDetail = true;
  await assert.rejects(f.amelu.sync(c.id), /500/);
  assert.equal(f.amelu.list()[0].status, 'error');
  assert.equal((await f.amelu.sync(c.id)).imported, 56);
  assert.equal(f.amelu.list()[0].status, 'ready');
  f.remote.catchall = 'changed@mail.example';
  await assert.rejects(f.amelu.sync(c.id), /Catch-all 已改变/);
  f.db.prepare('UPDATE amelu_connections SET enabled=0 WHERE id=?').run(c.id);
  assert.deepEqual(await f.amelu.sync(c.id), { skipped:true });
});

test('management endpoints require authentication and never disclose stored secrets', async t => {
  const f = fixture(t);
  await connect(f);
  const app = express(); app.use(express.json());
  f.amelu.mount(app, (req,res,next) => req.headers['x-test-admin'] === 'yes' ? next() : res.status(401).end());
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/amelu/connections`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, { headers:{ 'x-test-admin':'yes' } });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!/password|amelu_mock_test_key|"secret"/.test(body));
});

test('invalid keys and missing API read permission fail before saving an existing connection', async t => {
  const f = fixture(t);
  await assert.rejects(f.amelu.discover('amelu_invalid_mock_key'), /401.*API Key/);
  f.remote.catchall = 'existing@mail.example';
  f.remote.mailboxes = [{ id:'existing', address:f.remote.catchall }];
  for (const status of [401, 403, 429]) {
    f.remote.readStatus = status;
    await assert.rejects(connect(f), error => error.upstreamStatus === status && !error.message.includes('upstream secret'));
    assert.equal(f.amelu.list().length, 0);
  }
  assert.equal(f.remote.calls.filter(c => c.method !== 'GET').length, 0);
  f.remote.readStatus = 200;
  assert.equal((await connect(f)).status, 'ready');
});

test('API detail access is required before accepting a connection', async t => {
  const f = fixture(t);
  f.remote.catchall = 'existing@mail.example';
  f.remote.mailboxes = [{ id:'existing', address:f.remote.catchall }];
  f.remote.messages = [message('old')];
  f.remote.failDetail = true;
  await assert.rejects(connect(f), /500/);
  assert.equal(f.amelu.list().length, 0);
  assert.equal((await connect(f)).status, 'ready');
});

test('legacy encrypted connections migrate without mailbox login or duplicate imports', async t => {
  const f = fixture(t);
  const c = await connect(f);
  prepareMailbox(f);
  f.remote.messages = [message('already-seen'), message('new')];
  f.amelu.importMessage(c, f.remote.messages[0]);
  f.db.prepare('UPDATE amelu_connections SET secret=?,scan_position=250,scan_until=? WHERE id=?')
    .run(f.amelu.getBox().encrypt({ key:f.key, address:c.mailbox_address, password:'obsolete_mock' }), new Date().toISOString(), c.id);
  assert.equal((await f.amelu.sync(c.id)).pending, 1);
  const saved = f.db.prepare('SELECT secret,scan_position,scan_until FROM amelu_connections').get();
  assert.deepEqual(f.amelu.getBox().decrypt(saved.secret), { key:f.key, transport:'api' });
  assert.equal(saved.scan_position, 0);
  assert.equal(saved.scan_until, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM amelu_messages').get().n, 2);
});

test('bounded API pagination resumes and rescans offsets shifted by arrival or deletion', async t => {
  const f = fixture(t);
  const c = await connect(f);
  prepareMailbox(f);
  f.remote.messages = Array.from({ length:306 }, (_,i) => message('page-' + i, undefined,
    { receivedAt:new Date(Date.now() - 10000 - i * 1000).toISOString() }));
  assert.equal((await f.amelu.sync(c.id)).pending, 250);
  assert.equal(f.db.prepare('SELECT scan_position FROM amelu_connections').get().scan_position, 250);
  f.remote.messages.shift();
  assert.equal((await f.amelu.sync(c.id)).pending, 55);
  assert.equal(f.db.prepare('SELECT scan_position FROM amelu_connections').get().scan_position, 0);
  f.remote.messages.unshift(message('new-arrival'));
  await f.amelu.sync(c.id);
  await f.amelu.sync(c.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM amelu_messages').get().n, 307);
  assert.equal(f.remote.calls.filter(c => c.endpoint.endsWith('/messages') && c.query.includes('position=250')).length, 2);
});

test('only post-connection messages inside retention are imported; ambiguous recipients stay pending', async t => {
  const f = fixture(t);
  const c = await connect(f, { routing:'headers', acceptHeaderRisk:true });
  prepareMailbox(f);
  f.db.prepare('UPDATE amelu_connections SET created_at=?').run(new Date(Date.now() - 60000).toISOString());
  f.remote.messages = [message('current'), message('hidden-recipient', 'elsewhere@example.com'),
    message('too-early', undefined, { receivedAt:new Date(Date.now() - 120000).toISOString() }),
    message('expired', undefined, { receivedAt:new Date(Date.now() - 49 * 3600000).toISOString() })];
  assert.deepEqual(await f.amelu.sync(c.id), { imported:1, pending:1 });
  f.db.prepare("UPDATE amelu_connections SET created_at='2020-01-01T00:00:00.000Z'").run();
  assert.deepEqual(await f.amelu.sync(c.id), { imported:1, pending:0 });
  assert.equal(f.remote.detailRequests, 3);
});

test('pausing during detail requests leaves the page available for a later retry', async t => {
  const f = fixture(t);
  const c = await connect(f);
  prepareMailbox(f);
  f.remote.messages = [message('pause-a'), message('pause-b')];
  f.remote.onDetail = () => f.db.prepare("UPDATE amelu_connections SET enabled=0,status='paused'").run();
  assert.deepEqual(await f.amelu.sync(c.id), { imported:0, pending:0 });
  assert.equal(f.db.prepare('SELECT scan_position FROM amelu_connections').get().scan_position, 0);
  assert.equal(f.amelu.list()[0].status, 'paused');
  f.remote.onDetail = null;
  f.db.prepare('UPDATE amelu_connections SET enabled=1').run();
  assert.equal((await f.amelu.sync(c.id)).pending, 2);
});

test('deleted remote messages do not block the page; rate limits retain the cursor for retry', async t => {
  const f = fixture(t);
  const c = await connect(f);
  prepareMailbox(f);
  f.remote.messages = [message('gone'), message('remaining')];
  f.remote.missing.add('gone');
  f.remote.readStatus = 429;
  await assert.rejects(f.amelu.sync(c.id), /429/);
  assert.equal(f.db.prepare('SELECT scan_position FROM amelu_connections').get().scan_position, 0);
  f.remote.readStatus = 200;
  assert.equal((await f.amelu.sync(c.id)).pending, 1);
});

test('different accounts and domains keep keys, message IDs and mailbox assignment isolated', async t => {
  const f = fixture(t);
  const other = fixture(t, { key:'amelu_other_mock_key', domain:'other.example', domainId:'domain-2' });
  const firstTransport = f.amelu.fetch;
  f.amelu.fetch = (url, options) => options.headers.Authorization === `Bearer ${other.key}`
    ? other.amelu.fetch(url, options) : firstTransport(url, options);
  const c1 = await connect(f, { routing:'headers', acceptHeaderRisk:true });
  const c2 = await connect({ ...other, amelu:f.amelu }, { routing:'headers', acceptHeaderRisk:true });
  prepareMailbox(f);
  prepareMailbox(f, 'alice@other.example');
  f.remote.messages = [message('same-remote-id')];
  other.remote.messages = [message('same-remote-id', 'alice@other.example', { textBody:'Other account' })];
  await Promise.all([f.amelu.sync(c1.id), f.amelu.sync(c2.id)]);
  assert.deepEqual(f.db.prepare('SELECT recipient,body_text FROM emails ORDER BY recipient').all(), [
    { recipient:'alice@mail.example', body_text:'Hello same-remote-id' },
    { recipient:'alice@other.example', body_text:'Other account' },
  ]);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM amelu_messages').get().n, 2);
  const draft = await f.amelu.discover(f.key);
  await assert.rejects(f.amelu.inspect(draft.token, other.domainId), /有效域名/);
});

test('malformed API responses fail explicitly instead of saving empty bodies or skipping pages', async t => {
  const f = fixture(t);
  const c = await connect(f);
  prepareMailbox(f);
  f.remote.messages = [message('format')];
  f.remote.badList = { messages:f.remote.messages, total:1, position:99 };
  await assert.rejects(f.amelu.sync(c.id), /列表格式/);
  f.remote.badList = null;
  f.remote.badDetail = { ...f.remote.messages[0], textBody:[{ partId:'old-format' }] };
  await assert.rejects(f.amelu.sync(c.id), /详情格式/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM amelu_messages').get().n, 0);
  f.remote.badDetail = null;
  assert.equal((await f.amelu.sync(c.id)).pending, 1);
});

test('backend and all inline frontend scripts parse; wait compares timestamps, not date strings', () => {
  const vm = require('node:vm');
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'public/amelu-admin.js'), 'utf8'));
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'public/access-passwords.js'), 'utf8'));
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'public/snowmail-ui.js'), 'utf8'));
  for (const file of ['private/admin.html','public/index.html','public/mailbox.html','public/verify.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1], { filename:file });
  }
  const db = new Database(':memory:');
  try { assert.equal(db.prepare("SELECT julianday('2026-11-07 06:05:50') > julianday('2026-11-07T06:00:00.000Z') AS ok").get().ok, 1); }
  finally { db.close(); }
});
