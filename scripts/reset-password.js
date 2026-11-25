#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { AccessControl } = require('../lib/access-control');

const rootDir = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR || rootDir);
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'mail.db');

const newPassword = process.argv.slice(2).join(' ').trim();

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

try {
  const access = new AccessControl(db, process.env.API_KEY || 'env-fallback');
  if (newPassword) {
    access.forceSetMasterPassword(newPassword);
    console.log('[SnowMail] 主管理员密码已强制更新并立即生效（无需重启服务，旧会话已自动下线，邮箱与邮件数据完好保留）。');
  } else {
    const result = access.resetMasterToEnv();
    if (result.reset) {
      console.log('[SnowMail] 已清除网页改密记录，主管理员密码已立即恢复为服务器环境变量 API_KEY（无需重启服务，数据完好保留）。');
    } else {
      console.log('[SnowMail] 当前未设置网页自定义主密码，仍以服务器环境变量 API_KEY 为准。');
    }
  }
} catch (error) {
  console.error('[SnowMail] 重置失败：', error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
