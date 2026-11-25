const express = require('express');
const cors = require('cors');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const { Amelu } = require('./lib/amelu');
const { AccessControl } = require('./lib/access-control');

function normalizeDomain(domain) {
  return String(domain || '')
    .trim()
    .replace(/^@+/, '')
    .toLowerCase();
}

function parseMailDomains() {
  const raw = process.env.MAIL_DOMAINS || process.env.MAIL_DOMAIN || 'example.com';
  const domains = raw
    .split(',')
    .map(normalizeDomain)
    .filter(Boolean);
  const defaultDomain = normalizeDomain(process.env.DEFAULT_MAIL_DOMAIN) || domains[0] || 'example.com';
  return [...new Set([defaultDomain, ...domains])];
}

const MAIL_DOMAINS = parseMailDomains();

const CONFIG = {
  domain: MAIL_DOMAINS[0],
  domains: MAIL_DOMAINS,
  smtpPort: parseInt(process.env.SMTP_PORT || '25', 10),
  apiPort: parseInt(process.env.API_PORT || '8080', 10),
  retentionHours: parseInt(process.env.RETENTION_HOURS || '48', 10),
  cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL || '10', 10),
  apiKey: process.env.API_KEY || '',
  smtpEnabled: !['false', '0', 'off'].includes(String(process.env.SMTP_ENABLED || '').toLowerCase()),
  maxMailSize: 10 * 1024 * 1024,
};

const PUBLIC_RATE_LIMITS = {
  meta: { windowMs: 60 * 1000, max: 10 },
  mailbox: { windowMs: 60 * 1000, max: 30 },
  email: { windowMs: 60 * 1000, max: 60 },
};

const AUTH_FAIL_LIMIT = {
  windowMs: 60 * 1000,
  max: Math.max(5, parseInt(process.env.AUTH_MAX_FAILURES_PER_MIN || '15', 10)),
};

const MAX_RATE_BUCKETS = 10000;
const MAX_ADMIN_SESSIONS = 500;
const publicRateBuckets = new Map();
const authFailureBuckets = new Map();
const adminSessions = new Map();
const ADMIN_SESSION_COOKIE = 'snowmail_admin_session';
const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const publicDir = path.join(__dirname, 'public');
const privateDir = path.join(__dirname, 'private');

const dataDir = path.resolve(process.env.DATA_DIR || __dirname);
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'mail.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
const accessControl = new AccessControl(db, CONFIG.apiKey);

db.exec(`
  CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    sender TEXT NOT NULL,
    subject TEXT DEFAULT '',
    body_text TEXT DEFAULT '',
    body_html TEXT DEFAULT '',
    raw_source TEXT DEFAULT '',
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_recipient ON emails(recipient);
  CREATE INDEX IF NOT EXISTS idx_received_at ON emails(received_at);

  CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    label TEXT DEFAULT '',
    retention_hours INTEGER DEFAULT 24,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME DEFAULT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_mb_address ON mailboxes(address);
  CREATE INDEX IF NOT EXISTS idx_mb_expires ON mailboxes(expires_at);
`);

const amelu = new Amelu({ db, dataDir, retentionHours: CONFIG.retentionHours,
  secretKey: process.env.AMELU_SECRET_KEY,
  intervalMs: Number(process.env.AMELU_SYNC_SECONDS || 15) * 1000 });

function availableDomains() {
  return [...new Set([...(CONFIG.smtpEnabled ? CONFIG.domains.filter(domain => !amelu.ownsDomain(domain)) : []), ...amelu.domains()])];
}

function defaultDomain() { return availableDomains()[0] || ''; }

const stmts = {
  insertEmail: db.prepare(`
    INSERT INTO emails (recipient, sender, subject, body_text, body_html, raw_source)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getEmails: db.prepare(`
    SELECT id, recipient, sender, subject, received_at
    FROM emails
    WHERE LOWER(recipient) = LOWER(?)
    ORDER BY received_at DESC
  `),
  getPublicEmails: db.prepare(`
    SELECT id, sender, subject, received_at
    FROM emails
    WHERE LOWER(recipient) = LOWER(?)
    ORDER BY received_at DESC
    LIMIT 20
  `),
  getEmailById: db.prepare(`
    SELECT id, recipient, sender, subject, body_text, body_html, received_at
    FROM emails
    WHERE id = ?
  `),
  getEmailByIdForRecipient: db.prepare(`
    SELECT id, sender, subject, body_text, body_html, received_at
    FROM emails
    WHERE id = ? AND LOWER(recipient) = LOWER(?)
  `),
  getLatest: db.prepare(`
    SELECT id, recipient, sender, subject, body_text, body_html, received_at
    FROM emails
    WHERE LOWER(recipient) = LOWER(?)
    ORDER BY received_at DESC
    LIMIT 1
  `),
  getRaw: db.prepare(`SELECT raw_source FROM emails WHERE id = ?`),
  deleteByRecipient: db.prepare(`DELETE FROM emails WHERE LOWER(recipient) = LOWER(?)`),
  deleteById: db.prepare(`DELETE FROM emails WHERE id = ?`),
  cleanup: db.prepare(`DELETE FROM emails WHERE received_at < datetime('now', ?)`),
  waitEmail: db.prepare(`
    SELECT id, recipient, sender, subject, body_text, body_html, received_at
    FROM emails
    WHERE LOWER(recipient) = LOWER(?) AND julianday(received_at) > julianday(?)
    ORDER BY received_at DESC
    LIMIT 1
  `),
  getAddresses: db.prepare(`
    SELECT LOWER(recipient) AS address, COUNT(*) AS count, MAX(received_at) AS last_received
    FROM emails
    GROUP BY LOWER(recipient)
    ORDER BY last_received DESC
  `),
  createMailbox: db.prepare(`
    INSERT OR REPLACE INTO mailboxes (address, label, retention_hours, created_at, expires_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
  `),
  getMailboxes: db.prepare(`
    SELECT
      m.*,
      COUNT(e.id) AS email_count
    FROM mailboxes m
    LEFT JOIN emails e ON LOWER(e.recipient) = LOWER(m.address)
    GROUP BY m.id
    ORDER BY m.created_at DESC
  `),
  getMailbox: db.prepare(`SELECT * FROM mailboxes WHERE LOWER(address) = LOWER(?)`),
  deleteMailbox: db.prepare(`DELETE FROM mailboxes WHERE LOWER(address) = LOWER(?)`),
  getExpiredMailboxes: db.prepare(`
    SELECT address
    FROM mailboxes
    WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP
  `),
  mailboxStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM mailboxes) AS total_mailboxes,
      (SELECT COUNT(*) FROM mailboxes WHERE expires_at IS NULL) AS permanent,
      (SELECT COUNT(*) FROM emails) AS total_emails
  `),
  countEmails: db.prepare(`SELECT COUNT(*) AS count FROM emails WHERE LOWER(recipient) = LOWER(?)`),
};

function getApiKey(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
}

function getCookieValue(req, name) {
  const raw = req.headers.cookie || '';
  if (!raw) {
    return '';
  }

  for (const chunk of raw.split(';')) {
    const [key, ...rest] = chunk.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(rest.join('=')); }
      catch { return ''; }
    }
  }

  return '';
}

function isSecureRequest(req) {
  if (req.secure) {
    return true;
  }

  if (isLoopbackAddress(req.socket?.remoteAddress)) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    if (forwardedProto === 'https') {
      return true;
    }

    const cfVisitor = String(req.headers['cf-visitor'] || '').toLowerCase();
    if (cfVisitor.includes('"https"')) {
      return true;
    }
  }

  return false;
}

function cleanupRateMap(map, now) {
  for (const [key, bucket] of map.entries()) {
    if (!bucket || bucket.resetAt <= now) {
      map.delete(key);
    }
  }
}

function setBoundedBucket(map, key, value) {
  if (!map.has(key) && map.size >= MAX_RATE_BUCKETS) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
  map.set(key, value);
}

function checkAuthFailureLimit(req, res) {
  const now = Date.now();
  const key = getRateLimitKey(req);
  const bucket = authFailureBuckets.get(key);
  if (bucket && bucket.resetAt > now && bucket.count >= AUTH_FAIL_LIMIT.max) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many failed authentication attempts, please try again later' });
    return true;
  }
  return false;
}

function recordAuthFailure(req) {
  const now = Date.now();
  const key = getRateLimitKey(req);
  const bucket = authFailureBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    setBoundedBucket(authFailureBuckets, key, { count: 1, resetAt: now + AUTH_FAIL_LIMIT.windowMs });
    return;
  }
  bucket.count += 1;
}

function hasMatchingSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === String(req.get('host') || '').toLowerCase();
  } catch {
    return false;
  }
}

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (!session || session.expiresAt <= now) {
      adminSessions.delete(token);
    }
  }
  cleanupRateMap(publicRateBuckets, now);
  cleanupRateMap(authFailureBuckets, now);
}

function hasValidAdminSession(req) {
  cleanupAdminSessions();
  const token = getCookieValue(req, ADMIN_SESSION_COOKIE);
  if (!token) {
    return false;
  }

  const session = adminSessions.get(token);
  if (!session || session.expiresAt <= Date.now() || !accessControl.isActive(session.identity)) {
    adminSessions.delete(token);
    return false;
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !hasMatchingSameOrigin(req)) {
    return false;
  }

  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  req.identity = session.identity;
  return true;
}

function setAdminSession(req, res, identity) {
  const previousToken = getCookieValue(req, ADMIN_SESSION_COOKIE);
  if (previousToken) adminSessions.delete(previousToken);
  if (adminSessions.size >= MAX_ADMIN_SESSIONS) {
    const oldestToken = adminSessions.keys().next().value;
    if (oldestToken !== undefined) adminSessions.delete(oldestToken);
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, {
    identity,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  res.cookie(ADMIN_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
    maxAge: ADMIN_SESSION_TTL_MS,
  });
}

function clearAdminSession(req, res) {
  const token = getCookieValue(req, ADMIN_SESSION_COOKIE);
  if (token) {
    adminSessions.delete(token);
  }
  res.clearCookie(ADMIN_SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    path: '/',
  });
}

function auth(req, res, next) {
  if (!accessControl.isConfigured()) {
    return res.status(503).json({ error: 'Admin API key is not configured' });
  }

  const explicitKey = req.headers.authorization !== undefined || req.headers['x-api-key'] !== undefined;
  if (explicitKey) {
    if (checkAuthFailureLimit(req, res)) return;
    req.identity = accessControl.authenticate(getApiKey(req));
    if (!req.identity) {
      recordAuthFailure(req);
      return res.status(401).json({ error: 'Invalid API key' });
    }
  } else if (!hasValidAdminSession(req)) {
    return res.status(401).json({ error: 'Admin login required' });
  }

  return next();
}

function adminOnly(req, res, next) {
  return auth(req, res, () => {
    if (req.identity.role !== 'admin') {
      return res.status(403).json({ error: '此操作仅主管理员可用。', code: 'ADMIN_REQUIRED' });
    }
    return next();
  });
}

function getAllowedDomain(domain) {
  const normalized = normalizeDomain(domain);
  return availableDomains().find(item => item === normalized) || '';
}

function getDomainFromAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at === -1) {
    return '';
  }
  return normalizeDomain(value.slice(at + 1));
}

function isAllowedMailboxAddress(address) {
  const domain = getDomainFromAddress(address);
  return CONFIG.smtpEnabled && CONFIG.domains.includes(domain) && !amelu.ownsDomain(domain);
}

const HUMAN_FIRST_NAMES = [
  'alex', 'amy', 'ben', 'cora', 'dylan', 'ella', 'eric', 'evan',
  'felix', 'hugo', 'iris', 'jane', 'jay', 'kevin', 'kira', 'leo',
  'lily', 'lucas', 'luna', 'mason', 'mia', 'mika', 'nina', 'noah',
  'nora', 'owen', 'ray', 'riley', 'ruby', 'sara', 'sean', 'tony', 'vera', 'zoe',
];

const HUMAN_LAST_NAMES = [
  'chen', 'feng', 'gao', 'han', 'he', 'huang', 'li', 'lin', 'liu',
  'lu', 'shen', 'song', 'sun', 'tang', 'wang', 'wu', 'xie', 'xu',
  'yang', 'ye', 'zhao', 'zhou',
];

const HUMAN_TAGS = ['box', 'cloud', 'desk', 'hello', 'home', 'inbox', 'lab', 'mail', 'note', 'work'];

function pickRandom(items) {
  return items[crypto.randomInt(0, items.length)];
}

function sanitizeLocalPart(value) {
  return String(value || '')
    .trim()
    .replace(/@.*$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
    .toLowerCase();
}

const ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomToken(len) {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += ALPHANUM[crypto.randomInt(0, ALPHANUM.length)];
  }
  return out;
}

function buildHumanLocalPart() {
  const first = pickRandom(HUMAN_FIRST_NAMES);
  const last = pickRandom(HUMAN_LAST_NAMES);
  const tag = pickRandom(HUMAN_TAGS);
  const suffix = randomToken(4);

  switch (crypto.randomInt(0, 4)) {
    case 0:
      return `${first}.${last}.${suffix}`;
    case 1:
      return `${first}_${tag}_${suffix}`;
    case 2:
      return `${first}.${tag}${suffix}`;
    default:
      return `${first}${last}.${suffix}`;
  }
}

function buildPrefixedLocalPart(prefix) {
  const safePrefix = sanitizeLocalPart(prefix) || 'mail';
  return `${safePrefix}-${randomToken(5)}`;
}

function createUniqueAddress(selectedDomain, prefix) {
  const hasPrefix = Boolean(String(prefix || '').trim());

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const localPart = hasPrefix ? buildPrefixedLocalPart(prefix) : buildHumanLocalPart();
    const address = `${localPart}@${selectedDomain}`.toLowerCase();
    if (!stmts.getMailbox.get(address) && !amelu.reserved(address)) {
      return address;
    }
  }

  return `mail-${crypto.randomBytes(4).toString('hex')}@${selectedDomain}`.toLowerCase();
}

const smtpServer = new SMTPServer({
  authOptional: true,
  secure: false,
  disabledCommands: ['AUTH', 'STARTTLS'],
  logger: false,
  onConnect(session, cb) {
    console.log(`[SMTP] ${new Date().toISOString()} | connect | ${session.remoteAddress}`);
    cb();
  },
  onMailFrom(addr, session, cb) {
    cb();
  },
  onRcptTo(addr, session, cb) {
    const address = addr.address.toLowerCase();
    if (isAllowedMailboxAddress(address)) {
      return cb();
    }
    return cb(new Error(`Rejected: ${address}`));
  },
  onData(stream, session, cb) {
    const chunks = [];
    let size = 0;

    stream.on('data', chunk => {
      size += chunk.length;
      if (size > CONFIG.maxMailSize) {
        stream.destroy();
        cb(new Error('Too large'));
        return;
      }
      chunks.push(chunk);
    });

    stream.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = await simpleParser(raw);
        const recipients = [...new Set((session.envelope?.rcptTo || []).map(item => item.address.toLowerCase()))];

        const sender = parsed.from?.text || 'unknown';
        const subject = parsed.subject || '(no subject)';

        for (const recipient of recipients) {
          if (!isAllowedMailboxAddress(recipient)) {
            continue;
          }
          stmts.insertEmail.run(
            recipient.toLowerCase(),
            sender,
            subject,
            parsed.text || '',
            parsed.html || '',
            raw
          );
          console.log(`[MAIL] ${new Date().toISOString()} | ${sender} -> ${recipient} | ${subject}`);
        }

        cb();
      } catch (error) {
        console.error('[MAIL] parse failed:', error.message);
        cb(error);
      }
    });
  },
  size: CONFIG.maxMailSize,
  banner: `${CONFIG.domain} SMTP Ready`,
});

const app = express();
app.disable('x-powered-by');
const rawTrustProxy = String(process.env.TRUST_PROXY || 'loopback').trim();
app.set(
  'trust proxy',
  rawTrustProxy === 'true' ? true : rawTrustProxy === 'false' ? false : rawTrustProxy
);

function deleteMailboxData(address) {
  const normalized = address.toLowerCase();
  amelu.deleted(normalized);
  const deletedMailbox = stmts.deleteMailbox.run(normalized).changes;
  const deletedEmails = stmts.deleteByRecipient.run(normalized).changes;

  return {
    deleted: deletedMailbox > 0 || deletedEmails > 0,
    deleted_mailbox: deletedMailbox,
    deleted_emails: deletedEmails,
  };
}

function normalizeMailboxAddress(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

function getPublicMailbox(address) {
  const normalized = normalizeMailboxAddress(address);
  if (!normalized) {
    return null;
  }
  const mailbox = stmts.getMailbox.get(normalized);
  if (mailbox?.expires_at && Date.parse(mailbox.expires_at + 'Z') <= Date.now()) return null;
  return mailbox;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPublicEmailBody(email) {
  const textBody = String(email?.body_text || '').trim();
  if (textBody) {
    return textBody;
  }
  return stripHtml(email?.body_html || '');
}

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function getRateLimitKey(req) {
  const remote = req.socket?.remoteAddress || '';
  if (isLoopbackAddress(remote) && typeof req.headers['cf-connecting-ip'] === 'string') {
    const cfIp = req.headers['cf-connecting-ip'].split(',')[0].trim();
    if (cfIp) return cfIp;
  }
  return String(req.ip || remote || 'unknown').split(',')[0].trim();
}

function publicRateLimit(name, options) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${name}:${getRateLimitKey(req)}`;
    const bucket = publicRateBuckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      setBoundedBucket(publicRateBuckets, key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (bucket.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests' });
    }

    bucket.count += 1;
    return next();
  };
}

app.use(
  '/api',
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self'; frame-src 'self' about: blob: data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});
app.use(express.static(publicDir, { index: false }));

app.get('/', (req, res) => {
  if (hasValidAdminSession(req)) {
    return res.redirect('/admin');
  }
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/admin', (req, res) => {
  if (!hasValidAdminSession(req)) {
    return res.redirect('/');
  }
  return res.sendFile(path.join(privateDir, 'admin.html'));
});

app.post('/api/admin/login', (req, res) => {
  if (!accessControl.isConfigured()) {
    return res.status(503).json({ error: 'Admin API key is not configured' });
  }
  if (!hasMatchingSameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin login forbidden' });
  }
  if (checkAuthFailureLimit(req, res)) {
    return;
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password) {
    return res.status(400).json({ error: 'Password is required' });
  }

  const identity = accessControl.authenticate(password);
  if (!identity) {
    recordAuthFailure(req);
    return res.status(401).json({ error: 'Invalid password' });
  }

  setAdminSession(req, res, identity);
  return res.json({ success: true, ...accessControl.describe(identity) });
});

app.post('/api/admin/logout', (req, res) => {
  clearAdminSession(req, res);
  return res.json({ success: true });
});

app.get('/api/admin/session', auth, (req, res) => {
  res.json(accessControl.describe(req.identity));
});

app.get('/api/admin/access-passwords', adminOnly, (req, res) => {
  res.json({
    passwords: accessControl.list(),
    master: accessControl.masterStatus(),
  });
});

app.post('/api/admin/master-password', adminOnly, (req, res) => {
  if (checkAuthFailureLimit(req, res)) {
    return;
  }
  const currentPassword = typeof req.body?.current_password === 'string' ? req.body.current_password : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  try {
    const master = accessControl.changeMasterPassword(currentPassword, newPassword);
    for (const [token, session] of adminSessions) {
      if (session.identity?.role === 'admin') adminSessions.delete(token);
    }
    if (getCookieValue(req, ADMIN_SESSION_COOKIE)) {
      setAdminSession(req, res, { role: 'admin', masterVersion: master.updated_at });
    }
    res.json({ success: true, master });
  } catch (error) {
    if (error.code === 'WRONG_CURRENT_PASSWORD') {
      recordAuthFailure(req);
    }
    res.status(error.status || 500).json({ error: error.status ? error.message : '修改主密码失败，请稍后重试。' });
  }
});

app.post('/api/admin/access-passwords', adminOnly, (req, res) => {
  try {
    res.status(201).json(accessControl.create(req.body?.label));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : '创建失败，请稍后重试。' });
  }
});

app.delete('/api/admin/access-passwords/:id', adminOnly, (req, res) => {
  try {
    accessControl.revoke(req.params.id);
    for (const [token, session] of adminSessions) {
      if (session.identity?.passwordId === req.params.id) adminSessions.delete(token);
    }
    res.json({ success: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.status ? error.message : '撤销失败，请稍后重试。' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
  });
});

app.get('/api/public/mailbox/:address/meta', publicRateLimit('meta', PUBLIC_RATE_LIMITS.meta), (req, res) => {
  const mailbox = getPublicMailbox(req.params.address);
  if (!mailbox) {
    return res.status(404).json({ error: 'Mailbox not found' });
  }

  return res.json({
    address: mailbox.address,
  });
});

app.get('/api/public/mailbox/:address', publicRateLimit('mailbox', PUBLIC_RATE_LIMITS.mailbox), (req, res) => {
  const mailbox = getPublicMailbox(req.params.address);
  if (!mailbox) {
    return res.status(404).json({ error: 'Mailbox not found' });
  }

  const emails = stmts.getPublicEmails.all(mailbox.address);
  return res.json({
    address: mailbox.address,
    count: emails.length,
    emails,
  });
});

app.get('/api/public/email/:id', publicRateLimit('email', PUBLIC_RATE_LIMITS.email), (req, res) => {
  const mailbox = getPublicMailbox(req.query.address);
  if (!mailbox) {
    return res.status(404).json({ error: 'Mailbox not found' });
  }

  const email = stmts.getEmailByIdForRecipient.get(Number(req.params.id), mailbox.address);
  if (!email) {
    return res.status(404).json({ error: 'Not found' });
  }

  return res.json({
    id: email.id,
    sender: email.sender,
    subject: email.subject,
    received_at: email.received_at,
    body_text: getPublicEmailBody(email),
  });
});

app.get('/api/config', auth, (req, res) => {
  res.json({
    domain: defaultDomain(),
    domains: availableDomains(),
    smtpEnabled: CONFIG.smtpEnabled,
    ameluDomains: amelu.domains(),
    apiKeyEnabled: Boolean(CONFIG.apiKey),
  });
});

amelu.mount(app, adminOnly);

app.post('/api/generate', auth, (req, res) => {
  const { prefix, custom, domain, retention_hours } = req.body || {};
  const requestedDomain = normalizeDomain(domain);
  const selectedDomain = requestedDomain ? getAllowedDomain(requestedDomain) : defaultDomain();
  if (!selectedDomain) {
    return res.status(400).json({ error: 'Domain is not allowed' });
  }
  const hours = Number(retention_hours ?? 24);
  if (!Number.isFinite(hours) || hours < 0 || hours > 87600) return res.status(400).json({ error: 'Invalid retention hours' });
  let address;

  if (custom !== undefined && typeof custom !== 'string') return res.status(400).json({ error: 'Invalid address name' });
  if (custom && custom.trim()) {
    const name = sanitizeLocalPart(custom);

    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Invalid address name (min 2 chars)' });
    }

    address = `${name}@${selectedDomain}`;
    const existing = stmts.getMailbox.get(address);
    if (existing) {
      return res.status(409).json({ error: 'Address already exists', address });
    }
  } else {
    address = createUniqueAddress(selectedDomain, prefix);
  }

  if (amelu.reserved(address)) return res.status(409).json({ error: '这个地址是 Amelu 已有独立邮箱，请换一个临时地址名称。' });

  let expiresAt = null;
  if (hours > 0) {
    expiresAt = new Date(Date.now() + hours * 3600000)
      .toISOString()
      .replace('T', ' ')
      .substring(0, 19);
  }

  stmts.createMailbox.run(address.toLowerCase(), '', hours, expiresAt);
  amelu.created(address);
  console.log(
    `[MAILBOX] ${new Date().toISOString()} | create | ${address} | ${
      hours > 0 ? `${hours}h` : 'permanent'
    }`
  );
  return res.json({ address, retention_hours: hours, expires_at: expiresAt });
});

app.get('/api/generate', auth, (req, res) => {
  const requestedDomain = normalizeDomain(req.query.domain);
  const selectedDomain = requestedDomain ? getAllowedDomain(requestedDomain) : defaultDomain();
  if (!selectedDomain) {
    return res.status(400).json({ error: 'Domain is not allowed' });
  }
  const address = createUniqueAddress(selectedDomain, req.query.prefix);
  const exp = new Date(Date.now() + 24 * 3600000).toISOString().replace('T', ' ').substring(0, 19);
  stmts.createMailbox.run(address.toLowerCase(), '', 24, exp);
  amelu.created(address);
  res.json({ address });
});

app.get('/api/mailboxes', auth, (req, res) => {
  const mailboxes = stmts.getMailboxes.all().map(mailbox => ({
    ...mailbox,
    email_count: Number(mailbox.email_count) || 0,
  }));
  res.json({ mailboxes });
});

app.delete('/api/mailboxes/:address', auth, (req, res) => {
  res.json(deleteMailboxData(req.params.address));
});

app.get('/api/mailbox/:address', auth, (req, res) => {
  const address = req.params.address.toLowerCase();
  const emails = stmts.getEmails.all(address);
  res.json({ address, count: emails.length, emails });
});

app.get('/api/email/:id', auth, (req, res) => {
  const email = stmts.getEmailById.get(Number(req.params.id));
  if (!email) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.json(email);
});

app.get('/api/mailbox/:address/latest', auth, (req, res) => {
  const email = stmts.getLatest.get(req.params.address.toLowerCase());
  if (!email) {
    return res.status(404).json({ error: 'No emails' });
  }
  return res.json(email);
});

app.get('/api/mailbox/:address/wait', auth, async (req, res) => {
  const address = req.params.address.toLowerCase();
  const timeout = Math.min(parseInt(req.query.timeout || '120', 10), 300);
  const since = req.query.since || new Date(Date.now() - 300000).toISOString();
  if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(timeout) || timeout < 1) return res.status(400).json({ error: 'Invalid since or timeout' });
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    // A revoked password must also stop requests already waiting for new mail.
    if (!accessControl.isActive(req.identity)) return res.status(401).json({ error: 'Admin login required' });
    if (res.destroyed) return;
    const email = stmts.waitEmail.get(address, since);
    if (email) {
      return res.json(email);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return res.status(408).json({ error: 'Timeout' });
});

app.get('/api/email/:id/raw', auth, async (req, res) => {
  const raw = stmts.getRaw.get(Number(req.params.id));
  if (!raw) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    let content = raw.raw_source;
    if (!content) {
      content = await amelu.raw(Number(req.params.id)) || '';
      if (content) db.prepare('UPDATE emails SET raw_source=? WHERE id=?').run(content, Number(req.params.id));
    }
    res.type('text/plain').send(content);
  } catch (error) {
    res.status(error.status || 502).json({ error: error.status ? error.message : '原文读取失败，请稍后重试。' });
  }
});

app.delete('/api/mailbox/:address', auth, (req, res) => {
  res.json(deleteMailboxData(req.params.address));
});

app.delete('/api/email/:id', adminOnly, (req, res) => {
  res.json({ deleted: stmts.deleteById.run(Number(req.params.id)).changes });
});

app.get('/api/stats', auth, (req, res) => {
  res.json(stmts.mailboxStats.get());
});

app.get('/api/addresses', auth, (req, res) => {
  res.json({ addresses: stmts.getAddresses.all() });
});

app.post('/api/ingest', adminOnly, (req, res) => {
  const { recipient, sender, subject, body_text, body_html, raw_source } = req.body || {};
  if (!recipient || !sender) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  stmts.insertEmail.run(
    recipient.toLowerCase(),
    sender,
    subject || '',
    body_text || '',
    body_html || '',
    raw_source || ''
  );
  return res.json({ success: true });
});

function cleanup() {
  const expiredEmails = stmts.cleanup.run(`-${CONFIG.retentionHours} hours`);
  if (expiredEmails.changes > 0) {
    console.log(`[CLEANUP] removed ${expiredEmails.changes} expired emails`);
  }

  for (const mailbox of stmts.getExpiredMailboxes.all()) {
    amelu.deleted(mailbox.address);
    stmts.deleteByRecipient.run(mailbox.address);
    stmts.deleteMailbox.run(mailbox.address);
    console.log(`[CLEANUP] expired mailbox ${mailbox.address}`);
  }
  amelu.cleanup();
}

if (CONFIG.smtpEnabled) smtpServer.listen(CONFIG.smtpPort, '0.0.0.0', () => {
  console.log('');
  console.log(`SnowMail ${CONFIG.domains.join(', ')}`);
  console.log(`SMTP :${CONFIG.smtpPort}  API :${CONFIG.apiPort}`);
  console.log(`API key: ${accessControl.isConfigured() ? 'enabled' : 'disabled'}`);
  console.log('');
});

smtpServer.on('error', error => {
  console.error('SMTP:', error.message);
});

const httpServer = app.listen(CONFIG.apiPort, process.env.API_HOST || '0.0.0.0', () => {
  console.log(`API http://${process.env.API_HOST || '0.0.0.0'}:${CONFIG.apiPort}`);
});

const cleanupTimer = setInterval(cleanup, CONFIG.cleanupInterval * 60000);
const sessionTimer = setInterval(cleanupAdminSessions, 10 * 60 * 1000);
cleanup();
amelu.start();

async function shutdown() {
  clearInterval(cleanupTimer);
  clearInterval(sessionTimer);
  httpServer.close();
  if (CONFIG.smtpEnabled) smtpServer.close();
  await amelu.stop();
  db.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
