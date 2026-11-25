'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.amelu.org';
const iso = () => new Date().toISOString();
const sqlDate = value => new Date(value).toISOString().replace('T', ' ').slice(0, 19);
const address = value => String(value || '').trim().toLowerCase();
const domainOf = value => address(value).split('@')[1] || '';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function secretBox(keyFile, envKey, hasConnections) {
  let key;
  if (envKey) {
    if (!/^[a-f0-9]{64}$/i.test(envKey)) throw new Error('AMELU_SECRET_KEY must be 64 hexadecimal characters');
    key = Buffer.from(envKey, 'hex');
  } else {
    if (!fs.existsSync(keyFile)) {
      if (hasConnections) throw new Error('Amelu encryption key missing; restore the key with the database');
      fs.mkdirSync(path.dirname(keyFile), { recursive: true });
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    }
    key = fs.readFileSync(keyFile);
    if (key.length !== 32) throw new Error('Invalid Amelu encryption key file');
  }
  return {
    encrypt(data) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
    },
    decrypt(value) {
      try {
        const bytes = Buffer.from(value, 'base64');
        const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        cipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
      } catch { throw fail('连接凭据无法解密，请恢复原加密密钥或重新连接。', 503); }
    },
  };
}

// Header recipients are hints, not SMTP envelope evidence. Never fan out a
// catch-all message to public inboxes from To/Cc/Bcc without explicit opt-in.
function routeMessage(message, connection, isActive) {
  const hints = [...new Set(['to', 'cc', 'bcc'].flatMap(field =>
    (message[field] || []).map(item => address(item.email))
  ).filter(item => domainOf(item) === connection.domain && item !== connection.mailbox_address))];
  const active = hints.filter(isActive);
  if (connection.routing === 'headers' && hints.length === 1 && active.length === 1) {
    return { recipient: active[0], candidates: active, reason: '' };
  }
  const reason = !hints.length ? '邮件没有保留可识别的临时收件地址' :
    !active.length ? '对应地址尚未创建、已经删除或邮件早于地址创建时间' :
    hints.length > 1 ? '邮件标注了多个收件地址，请确认实际归属' : '请确认邮件实际属于这个地址';
  return { recipient: null, candidates: active, reason };
}

class Amelu {
  constructor({ db, dataDir, fetchImpl = fetch, retentionHours = 48, secretKey, intervalMs = 15000 }) {
    this.db = db;
    this.fetch = fetchImpl;
    this.retentionHours = Number.isFinite(retentionHours) && retentionHours > 0 ? retentionHours : 48;
    this.intervalMs = Number.isFinite(intervalMs) ? Math.max(5000, intervalMs) : 15000;
    this.drafts = new Map();
    this.jobs = new Map();
    this.connecting = new Set();
    this.stopped = false;
    db.exec(`
      CREATE TABLE IF NOT EXISTS amelu_connections (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL UNIQUE, domain_id TEXT NOT NULL,
        mailbox_id TEXT, mailbox_address TEXT, secret TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, routing TEXT NOT NULL DEFAULT 'review',
        reserved TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
        last_sync TEXT, last_error TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'setup',
        scan_position INTEGER NOT NULL DEFAULT 0, scan_until TEXT
      );
      CREATE TABLE IF NOT EXISTS amelu_messages (
        connection_id TEXT NOT NULL, remote_id TEXT NOT NULL, blob_id TEXT,
        local_id INTEGER, received_at TEXT NOT NULL, PRIMARY KEY(connection_id, remote_id)
      );
      CREATE INDEX IF NOT EXISTS idx_amelu_local_id ON amelu_messages(local_id);
      CREATE TABLE IF NOT EXISTS amelu_pending (
        id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, remote_id TEXT NOT NULL,
        reason TEXT NOT NULL, candidates TEXT NOT NULL, payload TEXT NOT NULL,
        received_at TEXT NOT NULL, UNIQUE(connection_id, remote_id)
      );
      CREATE TABLE IF NOT EXISTS amelu_mailbox_epochs (
        address TEXT PRIMARY KEY, not_before TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
      );
    `);
    const hasConnections = db.prepare('SELECT COUNT(*) AS n FROM amelu_connections').get().n > 0;
    // Defer creating a key file until the first connection is saved.
    this.getBox = () => {
      if (!this.box) this.box = secretBox(path.join(dataDir, '.amelu-key'), secretKey, hasConnections);
      return this.box;
    };
  }

  async request(url, options = {}) {
    let response;
    try {
      response = await this.fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(25000) });
    } catch { throw fail('无法连接 Amelu，请检查网络后重试。', 502); }
    if (!response.ok) {
      // Do not echo upstream responses: they can contain credentials or HTML.
      const hint = response.status === 401 ? 'API Key 无效或已撤销，请用有效的 API Key 重新连接。' :
        response.status === 403 ? '账号没有所需权限或此操作未开放。' :
        response.status === 429 ? '请求过于频繁，请稍后重试。' :
        response.status === 409 ? '配置发生冲突，请刷新域名后重试。' :
        '请检查邮箱配额、域名设置后重试。';
      throw Object.assign(fail(`Amelu 返回 ${response.status}：${hint}`, 502), { upstreamStatus: response.status });
    }
    const limit = 6 * 1024 * 1024;
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw fail('Amelu 接口响应过大，请稍后重试。', 413);
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return text ? JSON.parse(text) : {}; }
    catch { throw fail('Amelu 返回了无法解析的数据，请稍后重试。', 502); }
  }

  api(key, endpoint, method = 'GET', body) {
    return this.request(API + endpoint, {
      method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async messages(key, mailboxId, position = 0, limit = 50) {
    const result = await this.api(key, `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages?folder=inbox&limit=${limit}&position=${position}`);
    if (!Array.isArray(result.messages) || !Number.isSafeInteger(result.total) || result.total < 0 ||
        result.position !== position || result.messages.length > limit ||
        result.messages.some(m => !m || typeof m.id !== 'string' || !m.id || !Number.isFinite(Date.parse(m.receivedAt)))) {
      throw fail('邮箱列表格式无效。', 502);
    }
    return result;
  }

  async message(key, mailboxId, remoteId) {
    const result = await this.api(key, `/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(remoteId)}`);
    if (!result || result.id !== remoteId || !Number.isFinite(Date.parse(result.receivedAt)) ||
        ['textBody', 'htmlBody'].some(field => result[field] != null && typeof result[field] !== 'string')) {
      throw fail('邮件详情格式无效。', 502);
    }
    return result;
  }

  async verifyMailbox(key, mailboxId) {
    const page = await this.messages(key, mailboxId, 0, 1);
    if (page.messages.length) await this.message(key, mailboxId, page.messages[0].id);
  }

  async discover(key) {
    if (typeof key !== 'string' || key.length < 15 || key.length > 500 || /\s/.test(key)) throw fail('请填写有效的 Amelu API Key。');
    const domains = await this.api(key, '/api/domains');
    if (!Array.isArray(domains)) throw fail('域名列表格式无效。', 502);
    for (const [id, draft] of this.drafts) if (draft.expires < Date.now()) this.drafts.delete(id);
    if (this.drafts.size >= 20) this.drafts.delete(this.drafts.keys().next().value);
    const token = crypto.randomBytes(24).toString('hex');
    this.drafts.set(token, { key, domains, expires: Date.now() + 15 * 60000 });
    return { token, domains: domains.map(d => ({ id: d.id, name: d.name, status: d.status,
      connected: Boolean(this.db.prepare('SELECT id FROM amelu_connections WHERE domain_id=?').get(d.id)) })) };
  }

  draft(token, domainId) {
    const draft = this.drafts.get(token);
    if (!draft || draft.expires < Date.now()) throw fail('连接信息已过期，请重新读取域名。');
    const domain = draft.domains.find(d => d.id === domainId);
    if (!domain || !/^[a-z0-9.-]+\.[a-z0-9-]+$/i.test(domain.name)) throw fail('请选择有效域名。');
    return { ...draft, domain };
  }

  async inspect(token, domainId) {
    const draft = this.draft(token, domainId);
    const [catchall, mailboxes, dns, aliases] = await Promise.all([
      this.api(draft.key, `/api/domains/${domainId}/catchall`),
      this.api(draft.key, `/api/domains/${domainId}/mailboxes`),
      this.api(draft.key, `/api/domains/${domainId}/dns`),
      this.api(draft.key, `/api/domains/${domainId}/aliases`),
    ]);
    const existing = this.db.prepare('SELECT * FROM amelu_connections WHERE domain_id=?').get(domainId);
    return { catchall: catchall.address || '', mailboxes: mailboxes.map(m => ({ id: m.id, address: m.address })),
      aliases: aliases.map(a => a.address || a.source || (a.localPart ? `${a.localPart}@${draft.domain.name}` : '')).filter(Boolean),
      dns: (dns.records || []).map(r => ({ type: r.type, name: r.name, status: r.status })),
      routing: existing?.routing || 'review' };
  }

  async connect(body) {
    const draft = this.draft(body.token, body.domainId);
    const domain = address(draft.domain.name);
    if (this.connecting.has(domain)) throw fail('这个域名正在配置，请稍候。', 409);
    this.connecting.add(domain);
    try {
      const info = await this.inspect(body.token, body.domainId);
      if (address(body.expectedCatchall) !== address(info.catchall)) throw fail('Catch-all 设置已改变，请重新选择域名确认。', 409);
      if (info.catchall && !info.mailboxes.some(m => m.address === info.catchall)) {
        throw fail('现有 Catch-all 指向外部地址或别名。请先在 Amelu 将其设为本域名下的独立收件邮箱，再连接。');
      }
      if (!body.confirmSetup) throw fail('请确认接收邮箱和 Catch-all 配置。');
      if (!['review', 'headers'].includes(body.routing)) throw fail('请选择收件分配方式。');
      if (body.routing === 'headers' && body.acceptHeaderRisk !== true) throw fail('请确认按邮件标注分配的适用范围。');
      const old = this.db.prepare('SELECT * FROM amelu_connections WHERE domain=?').get(domain);
      if (old && this.jobs.has(old.id)) throw fail('该域名正在同步，请稍后重新连接。', 409);
      const box = this.getBox();
      const id = old?.id || crypto.randomUUID();
      let mailboxAddress = info.catchall || old?.mailbox_address || `snowmail-${crypto.randomBytes(5).toString('hex')}@${domain}`;
      let mailbox = info.mailboxes.find(m => m.address === mailboxAddress);
      const credentials = { key: draft.key, transport: 'api' };
      if (mailbox) await this.verifyMailbox(draft.key, mailbox.id);
      // Persist intent before the external mutation; retry can recover a created mailbox.
      this.db.prepare(`INSERT INTO amelu_connections
        (id,domain,domain_id,mailbox_address,secret,routing,reserved,created_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(domain) DO UPDATE SET secret=excluded.secret,
        domain_id=excluded.domain_id,mailbox_address=excluded.mailbox_address,routing=excluded.routing,
        enabled=0,status='setup',last_error='',scan_position=0,scan_until=NULL`)
        .run(id, domain, body.domainId, mailboxAddress, box.encrypt(credentials), body.routing,
          JSON.stringify([...info.mailboxes.map(m => m.address), ...info.aliases]), old?.created_at || iso());
      if (!mailbox) {
        mailbox = await this.api(draft.key, `/api/domains/${body.domainId}/mailboxes`, 'POST', {
          localPart: mailboxAddress.split('@')[0], displayName: 'SnowMail 收信',
        });
        await this.verifyMailbox(draft.key, mailbox.id);
      }
      this.db.prepare('UPDATE amelu_connections SET mailbox_id=? WHERE id=?').run(mailbox.id, id);
      if (!info.catchall) await this.api(draft.key, `/api/domains/${body.domainId}/catchall`, 'PUT', { address: mailboxAddress });
      const confirmed = await this.api(draft.key, `/api/domains/${body.domainId}/catchall`);
      if (confirmed.address !== mailboxAddress) throw fail('Catch-all 验证失败，请刷新域名设置。', 502);
      this.db.prepare(`UPDATE amelu_connections SET enabled=1,status='ready',reserved=?,last_error='' WHERE id=?`)
        .run(JSON.stringify([...new Set([...info.mailboxes.map(m => m.address), ...info.aliases, mailboxAddress])]), id);
      this.drafts.delete(body.token);
      return this.list().find(item => item.id === id);
    } catch (error) {
      this.db.prepare("UPDATE amelu_connections SET last_error=? WHERE domain=? AND status='setup'").run(error.message, domain);
      throw error;
    } finally { this.connecting.delete(domain); }
  }

  list() {
    return this.db.prepare(`SELECT id,domain,domain_id,mailbox_address,enabled,routing,created_at,last_sync,
      last_error,status,(SELECT COUNT(*) FROM amelu_pending p WHERE p.connection_id=c.id) AS pending_count
      FROM amelu_connections c ORDER BY created_at`).all().map(row => ({ ...row, syncing: this.jobs.has(row.id) }));
  }

  domains() { return this.list().filter(row => row.enabled).map(row => row.domain); }
  ownsDomain(domain) { return Boolean(this.db.prepare('SELECT id FROM amelu_connections WHERE domain=?').get(domain)); }
  reserved(value) {
    const connection = this.db.prepare('SELECT reserved FROM amelu_connections WHERE domain=?').get(domainOf(value));
    return connection && JSON.parse(connection.reserved).includes(address(value));
  }
  created(value) {
    this.db.prepare(`INSERT INTO amelu_mailbox_epochs(address,not_before,deleted) VALUES (?,?,0)
      ON CONFLICT(address) DO UPDATE SET not_before=excluded.not_before,deleted=0`).run(address(value), iso());
  }
  deleted(value) {
    this.db.prepare(`INSERT INTO amelu_mailbox_epochs(address,not_before,deleted) VALUES (?,?,1)
      ON CONFLICT(address) DO UPDATE SET not_before=excluded.not_before,deleted=1`).run(address(value), iso());
  }
  active(value, receivedAt) {
    const row = this.db.prepare(`SELECT m.created_at,m.expires_at,e.not_before,e.deleted FROM mailboxes m
      LEFT JOIN amelu_mailbox_epochs e ON e.address=m.address WHERE m.address=?`).get(value);
    if (!row || row.deleted || (row.expires_at && Date.parse(row.expires_at + 'Z') <= Date.now())) return false;
    return Date.parse(receivedAt) >= Date.parse(row.not_before || row.created_at + 'Z');
  }

  async sync(id) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    const job = this.runSync(id);
    this.jobs.set(id, job);
    try { return await job; } finally { this.jobs.delete(id); }
  }

  async runSync(id) {
    const c = this.db.prepare('SELECT * FROM amelu_connections WHERE id=?').get(id);
    if (!c) throw fail('连接不存在。', 404);
    if (!c.enabled || this.connecting.has(c.domain)) return { skipped: true };
    try {
      const credentials = this.getBox().decrypt(c.secret);
      const currentCatchall = await this.api(credentials.key, `/api/domains/${c.domain_id}/catchall`);
      if (currentCatchall.address !== c.mailbox_address) throw fail('Catch-all 已改变，同步暂停导入，请重新连接确认收件邮箱。', 409);
      const after = Math.max(Date.parse(c.created_at), Date.now() - this.retentionHours * 3600000);
      const until = Date.now();
      // The API and the old mail service expose the same message IDs. Preserve
      // deduplication, but discard the old service's differently ordered cursor.
      let position = credentials.transport === 'api' ? c.scan_position : 0;
      let imported = 0, pending = 0;
      // The API lists newest first and has no date filter. Stop at the cutoff,
      // persist bounded pages, then rescan from the newest message.
      // Repeated scans cover shifts caused by remote deletion; permanent IDs
      // prevent deleted/expired local mail from ever being imported again.
      for (let page = 0; page < 5 && !this.stopped; page++) {
        if (!this.db.prepare('SELECT enabled FROM amelu_connections WHERE id=?').get(id)?.enabled) break;
        const query = await this.messages(credentials.key, c.mailbox_id, position);
        if (credentials.transport !== 'api') {
          this.db.prepare('UPDATE amelu_connections SET secret=?,scan_position=0,scan_until=NULL WHERE id=?')
            .run(this.getBox().encrypt({ key: credentials.key, transport: 'api' }), id);
          credentials.transport = 'api';
        }
        const unseen = query.messages.filter(m => Date.parse(m.receivedAt) >= after && Date.parse(m.receivedAt) <= until &&
          !this.db.prepare('SELECT 1 FROM amelu_messages WHERE connection_id=? AND remote_id=?').get(id, m.id));
        for (let offset = 0; offset < unseen.length; offset += 4) {
          if (this.stopped || !this.db.prepare('SELECT enabled FROM amelu_connections WHERE id=?').get(id)?.enabled) return { imported, pending };
          const details = await Promise.allSettled(unseen.slice(offset, offset + 4).map(m => this.message(credentials.key, c.mailbox_id, m.id)));
          if (this.stopped || !this.db.prepare('SELECT enabled FROM amelu_connections WHERE id=?').get(id)?.enabled) return { imported, pending };
          for (const detail of details) {
            if (detail.status === 'rejected') {
              // A message can be deleted remotely between listing and reading.
              if (detail.reason.upstreamStatus === 404) continue;
              throw detail.reason;
            }
            const message = detail.value;
            if (Date.parse(message.receivedAt) >= after && Date.parse(message.receivedAt) <= until) {
              const result = this.importMessage(c, message);
              imported += result === 'imported' ? 1 : 0;
              pending += result === 'pending' ? 1 : 0;
            }
          }
        }
        position += query.messages.length;
        const done = !query.messages.length || position >= query.total || query.messages.some(m => Date.parse(m.receivedAt) < after);
        this.db.prepare('UPDATE amelu_connections SET scan_position=?,scan_until=NULL WHERE id=?').run(done ? 0 : position, id);
        if (done) break;
      }
      this.db.prepare("UPDATE amelu_connections SET last_sync=?,last_error='',status=CASE WHEN enabled=1 THEN 'ready' ELSE 'paused' END WHERE id=?").run(iso(), id);
      return { imported, pending };
    } catch (error) {
      this.db.prepare("UPDATE amelu_connections SET last_error=?,status=CASE WHEN enabled=1 THEN 'error' ELSE 'paused' END WHERE id=?").run(error.status ? error.message : '同步失败，请稍后重试。', id);
      throw error.status ? error : fail('同步失败，请稍后重试。', 502);
    }
  }

  importMessage(connection, message) {
    if (!message.id || !Number.isFinite(Date.parse(message.receivedAt))) throw fail('邮件时间或标识无效。', 502);
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM amelu_messages WHERE connection_id=? AND remote_id=?').get(connection.id, message.id)) return 'seen';
      const payload = { sender: (message.from || []).map(item => item.name ? `${item.name} <${item.email}>` : item.email).join(', ') || 'unknown',
        subject: message.subject || '(无主题)', body_text: message.textBody || '', body_html: message.htmlBody || '', received_at: sqlDate(message.receivedAt) };
      const route = routeMessage(message, connection, value => this.active(value, message.receivedAt));
      this.db.prepare('INSERT INTO amelu_messages(connection_id,remote_id,blob_id,received_at) VALUES (?,?,?,?)')
        .run(connection.id, message.id, message.blobId || '', message.receivedAt);
      if (route.recipient) {
        const inserted = this.insertEmail(route.recipient, payload);
        this.db.prepare('UPDATE amelu_messages SET local_id=? WHERE connection_id=? AND remote_id=?').run(inserted, connection.id, message.id);
        return 'imported';
      }
      this.db.prepare('INSERT INTO amelu_pending(connection_id,remote_id,reason,candidates,payload,received_at) VALUES (?,?,?,?,?,?)')
        .run(connection.id, message.id, route.reason, JSON.stringify(route.candidates), JSON.stringify(payload), message.receivedAt);
      return 'pending';
    })();
  }

  insertEmail(recipient, payload) {
    return Number(this.db.prepare(`INSERT INTO emails(recipient,sender,subject,body_text,body_html,received_at)
      VALUES (?,?,?,?,?,?)`).run(recipient, payload.sender, payload.subject, payload.body_text, payload.body_html, payload.received_at).lastInsertRowid);
  }

  pending() {
    return this.db.prepare(`SELECT p.*,c.domain FROM amelu_pending p JOIN amelu_connections c ON c.id=p.connection_id
      ORDER BY p.received_at DESC LIMIT 100`).all().map(row => {
      const payload = JSON.parse(row.payload);
      return { id: row.id, domain: row.domain, reason: row.reason, candidates: JSON.parse(row.candidates),
        sender: payload.sender, subject: payload.subject, received_at: row.received_at, preview: payload.body_text.slice(0,500) };
    });
  }

  assign(id, recipient) {
    recipient = address(recipient);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT p.*,c.domain FROM amelu_pending p JOIN amelu_connections c ON c.id=p.connection_id WHERE p.id=?').get(id);
      if (!row) throw fail('待分配邮件不存在。', 404);
      if (domainOf(recipient) !== row.domain || !this.active(recipient, row.received_at)) throw fail('请选择同域名下、在收信时已创建且尚未过期的邮箱。');
      const localId = this.insertEmail(recipient, JSON.parse(row.payload));
      this.db.prepare('UPDATE amelu_messages SET local_id=? WHERE connection_id=? AND remote_id=?').run(localId, row.connection_id, row.remote_id);
      this.db.prepare('DELETE FROM amelu_pending WHERE id=?').run(id);
      return { id: localId, recipient };
    })();
  }

  async raw(localId) {
    const row = this.db.prepare('SELECT 1 FROM amelu_messages WHERE local_id=?').get(localId);
    if (!row) return null;
    throw fail('Amelu API 暂不提供原始邮件下载，请在 Amelu 查看原件。', 501);
  }

  mount(app, auth) {
    const wrap = handler => async (req, res) => {
      try { res.json(await handler(req)); }
      catch (error) { res.status(error.status || 500).json({ error: error.status ? error.message : '操作失败，请稍后重试。' }); }
    };
    const base = '/api/amelu';
    app.get(base + '/connections', auth, wrap(() => ({ connections: this.list() })));
    app.post(base + '/discover', auth, wrap(req => this.discover(req.body.apiKey)));
    app.post(base + '/inspect', auth, wrap(req => this.inspect(req.body.token, req.body.domainId)));
    app.post(base + '/connections', auth, wrap(req => this.connect(req.body)));
    app.post(base + '/connections/:id/sync', auth, wrap(req => this.sync(req.params.id)));
    app.patch(base + '/connections/:id', auth, wrap(req => {
      if (typeof req.body.enabled !== 'boolean') throw fail('请选择暂停或恢复同步。');
      const c = this.db.prepare('SELECT * FROM amelu_connections WHERE id=?').get(req.params.id);
      if (!c) throw fail('连接不存在。', 404);
      if (!c.mailbox_id || c.status === 'setup' || this.connecting.has(c.domain)) throw fail('请先完成域名连接配置。');
      this.db.prepare('UPDATE amelu_connections SET enabled=?,status=? WHERE id=?').run(req.body.enabled ? 1 : 0, req.body.enabled ? 'ready' : 'paused', c.id);
      return { success: true };
    }));
    app.get(base + '/pending', auth, wrap(() => ({ messages: this.pending() })));
    app.post(base + '/pending/:id/assign', auth, wrap(req => this.assign(Number(req.params.id), req.body.address)));
    app.delete(base + '/pending/:id', auth, wrap(req => ({ deleted: this.db.prepare('DELETE FROM amelu_pending WHERE id=?').run(Number(req.params.id)).changes })));
  }

  cleanup() {
    this.db.prepare('DELETE FROM amelu_pending WHERE received_at < ?').run(new Date(Date.now() - this.retentionHours * 3600000).toISOString());
  }
  start() {
    const tick = async () => {
      if (this.stopped) return;
      for (const c of this.list().filter(row => row.enabled)) {
        if (this.stopped) break;
        await this.sync(c.id).catch(() => {}); // Error is persisted for the admin UI.
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, 1000);
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.allSettled([...this.jobs.values()]);
  }
}

module.exports = { Amelu, routeMessage, secretBox };
