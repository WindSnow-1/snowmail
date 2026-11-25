const crypto = require('crypto');

const OPERATOR_PERMISSIONS = Object.freeze([
  'mailboxes:read', 'mailboxes:create', 'mailboxes:delete', 'emails:read',
]);

const WEAK_DEFAULT_PASSWORDS = new Set([
  'change-me-in-production',
  'replace-with-a-long-random-password',
  'password',
  '12345678',
  'admin123',
  'admin',
  '123456',
]);

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function saltedDigest(saltHex, value) {
  return crypto.createHmac('sha256', Buffer.from(saltHex, 'hex')).update(value).digest();
}

function invalid(message, status = 400, code = '') {
  return Object.assign(new Error(message), { status, code });
}

function validateNewMasterPassword(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 256) {
    throw invalid('请设置 8 - 256 个字符的新主密码。');
  }
  if (!newPassword.trim()) {
    throw invalid('新主密码不能全为空格。');
  }
  if (newPassword.startsWith('smop_')) {
    throw invalid('新主密码不能以 smop_ 开头（该前缀保留给 AI 操作密码）。');
  }
  if (WEAK_DEFAULT_PASSWORDS.has(newPassword.toLowerCase())) {
    throw invalid('请勿使用默认初始密码或常见弱密码。');
  }
}

class AccessControl {
  constructor(db, adminKey) {
    this.db = db;
    this.envEnabled = Boolean(adminKey);
    this.envIsDefaultWeak = Boolean(adminKey) && WEAK_DEFAULT_PASSWORDS.has(String(adminKey).toLowerCase());
    this.adminDigest = digest(adminKey || '');

    db.exec(`
      CREATE TABLE IF NOT EXISTS operator_passwords (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS admin_settings (
        key TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.bySecret = db.prepare('SELECT id, label FROM operator_passwords WHERE secret_hash=? AND revoked_at IS NULL');
    this.byId = db.prepare('SELECT id, label, revoked_at FROM operator_passwords WHERE id=?');
    this.touch = db.prepare(`UPDATE operator_passwords SET last_used_at=? WHERE id=?
      AND (last_used_at IS NULL OR last_used_at < ?)`);
    this.getMasterRow = db.prepare("SELECT salt, secret_hash, updated_at FROM admin_settings WHERE key='master_password'");
    this.upsertMasterRow = db.prepare(`
      INSERT INTO admin_settings (key, salt, secret_hash, updated_at)
      VALUES ('master_password', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        salt = excluded.salt,
        secret_hash = excluded.secret_hash,
        updated_at = excluded.updated_at
    `);
    this.deleteMasterRow = db.prepare("DELETE FROM admin_settings WHERE key='master_password'");
  }

  isConfigured() {
    return Boolean(this.envEnabled || this.getMasterRow.get());
  }

  masterVersion() {
    const row = this.getMasterRow.get();
    return row ? row.updated_at : 'env';
  }

  verifyMasterPassword(password) {
    if (!this.isConfigured() || typeof password !== 'string' || !password || password.length > 4096) {
      return false;
    }
    const row = this.getMasterRow.get();
    if (row) {
      const expected = Buffer.from(row.secret_hash, 'hex');
      const actual = saltedDigest(row.salt, password);
      return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
    }
    if (!this.envEnabled) return false;
    return crypto.timingSafeEqual(digest(password), this.adminDigest);
  }

  authenticate(password) {
    if (!this.isConfigured() || typeof password !== 'string' || !password || password.length > 4096) return null;
    if (this.verifyMasterPassword(password)) {
      return { role: 'admin', masterVersion: this.masterVersion() };
    }
    const hash = digest(password);
    const record = this.bySecret.get(hash.toString('hex'));
    if (!record) return null;
    this.markUsed(record.id);
    return { role: 'operator', passwordId: record.id, label: record.label };
  }

  isActive(identity) {
    if (!this.isConfigured() || !identity) return false;
    if (identity.role === 'admin') {
      if (identity.masterVersion !== undefined && identity.masterVersion !== this.masterVersion()) {
        return false;
      }
      return true;
    }
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

  masterStatus() {
    const row = this.getMasterRow.get();
    return {
      source: row ? 'custom' : 'env',
      updated_at: row ? row.updated_at : null,
      using_default_weak: !row && this.envIsDefaultWeak,
    };
  }

  changeMasterPassword(currentPassword, newPassword) {
    if (!this.verifyMasterPassword(currentPassword)) {
      throw invalid('当前主密码不正确。', 400, 'WRONG_CURRENT_PASSWORD');
    }
    validateNewMasterPassword(newPassword);
    if (this.verifyMasterPassword(newPassword)) {
      throw invalid('新主密码不能与当前主密码相同。');
    }
    return this.forceSetMasterPassword(newPassword);
  }

  forceSetMasterPassword(newPassword) {
    validateNewMasterPassword(newPassword);
    const salt = crypto.randomBytes(16).toString('hex');
    const secretHash = saltedDigest(salt, newPassword).toString('hex');
    const updatedAt = new Date().toISOString();
    this.upsertMasterRow.run(salt, secretHash, updatedAt);
    return {
      source: 'custom',
      updated_at: updatedAt,
      using_default_weak: false,
    };
  }

  resetMasterToEnv() {
    const changes = this.deleteMasterRow.run().changes;
    return {
      reset: changes > 0,
      source: 'env',
      updated_at: null,
      using_default_weak: this.envIsDefaultWeak,
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
