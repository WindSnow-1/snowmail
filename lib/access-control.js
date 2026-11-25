const crypto = require('crypto');

const OPERATOR_PERMISSIONS = Object.freeze([
  'mailboxes:read', 'mailboxes:create', 'mailboxes:delete', 'emails:read',
]);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

class AccessControl {
  constructor(db, adminKey) {
    this.db = db;
    this.enabled = Boolean(adminKey);
    this.adminDigest = digest(adminKey || '');
    db.exec(`CREATE TABLE IF NOT EXISTS operator_passwords (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    )`);
    this.bySecret = db.prepare('SELECT id, label FROM operator_passwords WHERE secret_hash=? AND revoked_at IS NULL');
    this.byId = db.prepare('SELECT id, label, revoked_at FROM operator_passwords WHERE id=?');
    this.touch = db.prepare(`UPDATE operator_passwords SET last_used_at=? WHERE id=?
      AND (last_used_at IS NULL OR last_used_at < ?)`);
  }

  authenticate(password) {
    if (!this.enabled || typeof password !== 'string' || !password || password.length > 4096) return null;
    const hash = digest(password);
    if (crypto.timingSafeEqual(hash, this.adminDigest)) return { role: 'admin' };
    const record = this.bySecret.get(hash.toString('hex'));
    if (!record) return null;
    this.markUsed(record.id);
    return { role: 'operator', passwordId: record.id, label: record.label };
  }

  isActive(identity) {
    if (!this.enabled || !identity) return false;
    if (identity.role === 'admin') return true;
    if (identity.role !== 'operator' || !identity.passwordId) return false;
    const record = this.byId.get(identity.passwordId);
    if (!record || record.revoked_at) return false;
    this.markUsed(record.id);
    return true;
  }

  markUsed(id) {
    const now = Date.now();
    this.touch.run(new Date(now).toISOString(), id, new Date(now - 60000).toISOString());
  }

  describe(identity) {
    return {
      role: identity.role,
      label: identity.role === 'admin' ? '主管理员' : identity.label,
      permissions: identity.role === 'admin' ? ['*'] : [...OPERATOR_PERMISSIONS],
    };
  }

  list() {
    return this.db.prepare(`SELECT id, label, created_at, last_used_at, revoked_at
      FROM operator_passwords ORDER BY created_at DESC, id`).all();
  }

  create(label) {
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 60) {
      throw invalid('请填写 1–60 个字符的用途备注。');
    }
    const id = crypto.randomUUID();
    // High-entropy generated passwords are stored only as one-way hashes.
    const password = 'smop_' + crypto.randomBytes(32).toString('base64url');
    const record = { id, label: label.trim(), created_at: new Date().toISOString(), last_used_at: null, revoked_at: null };
    this.db.prepare(`INSERT INTO operator_passwords (id, label, secret_hash, created_at)
      VALUES (?, ?, ?, ?)`).run(id, record.label, digest(password).toString('hex'), record.created_at);
    return { ...record, password };
  }

  revoke(id) {
    const record = this.byId.get(id);
    if (!record) throw invalid('操作密码不存在，请刷新列表。', 404);
    if (!record.revoked_at) {
      this.db.prepare('UPDATE operator_passwords SET revoked_at=? WHERE id=?').run(new Date().toISOString(), id);
    }
  }
}

module.exports = { AccessControl };
