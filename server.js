const express = require('express');
const cors = require('cors');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const Database = require('better-sqlite3');
const path = require('path');

const CONFIG = {
  domain: process.env.MAIL_DOMAIN || 'dart.lat',
  smtpPort: parseInt(process.env.SMTP_PORT || '25', 10),
  apiPort: parseInt(process.env.API_PORT || '8080', 10),
  retentionHours: parseInt(process.env.RETENTION_HOURS || '48', 10),
  cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL || '10', 10),
  apiKey: process.env.API_KEY || '',
  maxMailSize: 10 * 1024 * 1024,
};

const dbPath = path.join(__dirname, 'mail.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

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

const stmts = {
  insertEmail: db.prepare(`
    INSERT INTO emails (recipient, sender, subject, body_text, body_html, raw_source)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getEmails: db.prepare(`
    SELECT id, recipient, sender, subject, body_text, body_html, received_at
    FROM emails
    WHERE LOWER(recipient) = LOWER(?)
    ORDER BY received_at DESC
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
    WHERE LOWER(recipient) = LOWER(?) AND received_at > ?
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

  return req.headers['x-api-key'] || req.query.key || '';
}

function auth(req, res, next) {
  if (!CONFIG.apiKey) {
    return next();
  }

  const apiKey = getApiKey(req);
  if (apiKey !== CONFIG.apiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  return next();
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
    if (address.endsWith(`@${CONFIG.domain}`) || address.includes(CONFIG.domain)) {
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
        const recipients = [];

        if (parsed.to) {
          const toValues = Array.isArray(parsed.to.value) ? parsed.to.value : [parsed.to];
          toValues.forEach(item => {
            if (item.address) {
              recipients.push(item.address);
            } else if (item.text) {
              recipients.push(item.text);
            }
          });
        }

        if (session.envelope?.rcptTo) {
          session.envelope.rcptTo.forEach(item => {
            if (!recipients.includes(item.address)) {
              recipients.push(item.address);
            }
          });
        }

        const sender = parsed.from?.text || 'unknown';
        const subject = parsed.subject || '(no subject)';

        for (const recipient of recipients) {
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

function deleteMailboxData(address) {
  const normalized = address.toLowerCase();
  const deletedMailbox = stmts.deleteMailbox.run(normalized).changes;
  const deletedEmails = stmts.deleteByRecipient.run(normalized).changes;

  return {
    deleted: deletedMailbox > 0 || deletedEmails > 0,
    deleted_mailbox: deletedMailbox,
    deleted_emails: deletedEmails,
  };
}

app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', domain: CONFIG.domain, uptime: process.uptime() });
});

app.get('/api/config', auth, (req, res) => {
  res.json({
    domain: CONFIG.domain,
    apiKeyEnabled: Boolean(CONFIG.apiKey),
  });
});

app.post('/api/generate', auth, (req, res) => {
  const { prefix, custom, retention_hours } = req.body || {};
  const hours = retention_hours ?? 24;
  let address;

  if (custom && custom.trim()) {
    const name = custom
      .trim()
      .replace(/@.*$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .toLowerCase();

    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Invalid address name (min 2 chars)' });
    }

    address = `${name}@${CONFIG.domain}`;
    const existing = stmts.getMailbox.get(address);
    if (existing) {
      return res.status(409).json({ error: 'Address already exists', address });
    }
  } else {
    const prefixValue = prefix || 'snow';
    const rand = Math.random().toString(36).substring(2, 8);
    address = `${prefixValue}-${rand}@${CONFIG.domain}`;
  }

  let expiresAt = null;
  if (hours > 0) {
    expiresAt = new Date(Date.now() + hours * 3600000)
      .toISOString()
      .replace('T', ' ')
      .substring(0, 19);
  }

  stmts.createMailbox.run(address.toLowerCase(), '', hours, expiresAt);
  console.log(
    `[MAILBOX] ${new Date().toISOString()} | create | ${address} | ${
      hours > 0 ? `${hours}h` : 'permanent'
    }`
  );
  return res.json({ address, retention_hours: hours, expires_at: expiresAt });
});

app.get('/api/generate', auth, (req, res) => {
  const prefixValue = req.query.prefix || 'snow';
  const rand = Math.random().toString(36).substring(2, 8);
  const address = `${prefixValue}-${rand}@${CONFIG.domain}`;
  const exp = new Date(Date.now() + 24 * 3600000).toISOString().replace('T', ' ').substring(0, 19);
  stmts.createMailbox.run(address.toLowerCase(), '', 24, exp);
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
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    const email = stmts.waitEmail.get(address, since);
    if (email) {
      return res.json(email);
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return res.status(408).json({ error: 'Timeout' });
});

app.get('/api/email/:id/raw', auth, (req, res) => {
  const raw = stmts.getRaw.get(Number(req.params.id));
  if (!raw) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.type('text/plain').send(raw.raw_source);
});

app.delete('/api/mailbox/:address', auth, (req, res) => {
  res.json(deleteMailboxData(req.params.address));
});

app.delete('/api/email/:id', auth, (req, res) => {
  res.json({ deleted: stmts.deleteById.run(Number(req.params.id)).changes });
});

app.get('/api/stats', auth, (req, res) => {
  res.json(stmts.mailboxStats.get());
});

app.get('/api/addresses', auth, (req, res) => {
  res.json({ addresses: stmts.getAddresses.all() });
});

app.post('/api/ingest', auth, (req, res) => {
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
    stmts.deleteByRecipient.run(mailbox.address);
    stmts.deleteMailbox.run(mailbox.address);
    console.log(`[CLEANUP] expired mailbox ${mailbox.address}`);
  }
}

smtpServer.listen(CONFIG.smtpPort, '0.0.0.0', () => {
  console.log('');
  console.log(`SnowMail ${CONFIG.domain}`);
  console.log(`SMTP :${CONFIG.smtpPort}  API :${CONFIG.apiPort}`);
  console.log(`API key: ${CONFIG.apiKey ? 'enabled' : 'disabled'}`);
  console.log('');
});

smtpServer.on('error', error => {
  console.error('SMTP:', error.message);
});

app.listen(CONFIG.apiPort, '0.0.0.0', () => {
  console.log(`API http://0.0.0.0:${CONFIG.apiPort}`);
});

setInterval(cleanup, CONFIG.cleanupInterval * 60000);
cleanup();

process.on('SIGINT', () => {
  smtpServer.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  smtpServer.close(() => {
    db.close();
    process.exit(0);
  });
});
