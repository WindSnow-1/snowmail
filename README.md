<div align="center">

# SnowMail

**A lightweight catch-all mailbox server for temporary inboxes, multi-domain testing, and shareable single-mailbox pages.**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-233047?style=for-the-badge&logo=node.js&logoColor=8ee29b)](#requirements)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-233047?style=for-the-badge&logo=sqlite&logoColor=9ecbff)](#backup-and-restore)
[![Express](https://img.shields.io/badge/Express-API-233047?style=for-the-badge&logo=express&logoColor=ffffff)](#api)
[![SMTP](https://img.shields.io/badge/SMTP-Catch--All-233047?style=for-the-badge)](#dns-setup)

</div>

---

SnowMail receives email for one or more domains, stores messages in a local SQLite database, and gives you two ways to read them:

- A protected admin dashboard for managing all mailboxes.
- A public single-mailbox page for sharing one inbox without exposing the full admin panel.

It is intentionally small: one Node.js server, one SQLite database, static HTML pages, and normal DNS records.

## At A Glance

| Area | What SnowMail Provides |
| --- | --- |
| Mail receiving | Local SMTP, or Amelu hosted mail with HTTPS synchronization |
| Domains | Multi-domain mailbox creation and domain picker |
| Storage | Local SQLite database with WAL mode |
| Admin | Password login, server-side session cookie, protected APIs |
| Sharing | Public `verify.html` and `mailbox.html` for one mailbox |
| Automation | API key support for scripts and external tools |
| Cleanup | Expiring mailboxes plus permanent mailbox option |

## How It Works

```text
Sender
  |
  | email to user@example.com
  v
DNS MX record
  |
  | points to mx.example.com
  v
SnowMail SMTP :25
  |
  | parses and stores message
  v
SQLite mail.db
  |
  +--> Admin dashboard
  +--> Public single-mailbox page
  +--> API / automation scripts
```

## Project Structure

```text
server.js            Express API + SMTP server + SQLite storage
lib/amelu.js          Amelu setup, encrypted API keys, API synchronization
public/amelu-admin.*  Amelu admin form and pending-mail management
test/amelu.test.js    Integration and routing tests
public/index.html    Admin login page
public/verify.html   Public mailbox verification page
public/mailbox.html  Public single-mailbox inbox page
private/admin.html   Admin dashboard, served only after login
mail.db              Runtime database, created on the server
```

`mail.db` is not committed to Git. It is the runtime database that contains created mailboxes and received emails.

## Requirements

- Node.js 20+ (Node.js 22 LTS recommended)
- For local SMTP: a server with inbound port `25` open
- For Amelu: outbound HTTPS access; no inbound SMTP port required
- At least one domain you can configure with DNS
- Optional but recommended: Nginx in front of the web UI

Install and start:

```bash
npm install
npm start
```

## 接入 Amelu

域名需要先在 [Amelu](https://app.amelu.org/) 添加并配置收信 DNS。SnowMail 不代替 DNS 服务商配置域名。

如果只使用 Amelu，启动时关闭本机 SMTP：

```bash
SMTP_ENABLED=false API_KEY='your-long-random-admin-password' npm start
```

Windows PowerShell：

```powershell
$env:SMTP_ENABLED='false'
$env:API_KEY='your-long-random-admin-password'
npm start
```

打开后台，点击 **添加 Amelu**：

1. 粘贴 Amelu API Key，点击“读取域名”。此密钥需要管理邮箱和读取邮件的权限。
2. 选择域名，检查已有收件设置。
3. 没有 Catch-all 时，确认后自动创建一个专用收件邮箱并将其设为 Catch-all。随机临时地址只在本地创建，不各自占用独立邮箱配额。
4. 已有 Catch-all 时直接用 API Key 验证读信并沿用该邮箱，无需填写邮箱密码。外部转发地址不能直接用作此收件邮箱。
5. 选择分配方式、确认接入，再通过原有“新建邮箱”功能创建地址。域名会出现在原来的域名选择中。

### 邮件归属与密送限制

SnowMail 使用 Amelu API 读取邮件列表和正文。该 API 没有完整头部、Bcc 和原始 SMTP 收件地址，因此不能保证识别每封邮件的实际投递地址。

- **每封确认后分配（默认）**：先进入“待分配邮件”，只对管理员可见。选择实际收件邮箱后，邮件才进入普通/公开收件页。
- **按邮件标注自动分配（需明确勾选）**：适合自己使用的一组临时地址。只有 API 返回的 To/Cc 中恰好一个本域名地址，且该地址已创建、未过期、创建时间不晚于收信时间时才自动分配。多个地址、地址缺失等情况进入待分配。
- 邮件中的地址可能被伪造；自动模式不适用于不同用户之间的私密邮箱隔离。某些发信方会去掉 Bcc，无法保证每封密送都自动识别。多个收件人不会根据邮件头自动复制到多个公开邮箱。
- 已有独立邮箱和别名优先于 Catch-all，不能作为这里的随机地址使用。该接入同步专用汇集邮箱，不会把 admin/postmaster 等独立账户的私人邮件导入公开页。

### 同步、删除和恢复

- 默认每轮结束后等待 15 秒再同步；每个域名每轮最多扫描 250 封，然后继续下一批。支持“立即同步”、暂停/恢复和状态错误提示。
- 按时间从新到旧扫描列表，只导入首次接入之后、且处于邮件保留窗口内的邮件。先在 SnowMail 创建临时地址，再用于接收邮件。暂停时间超过保留窗口的邮件不会自动补回。
- 去重记录随数据库持久化，本地删除邮件或删除/重建邮箱后，旧邮件不会重新导入。去重标识不会随邮件清理而删除，会随邮件数量增长。
- 删除本地邮箱、忽略待分配邮件、暂停同步均不会删除 Amelu 原件，也不会撤销 Catch-all。需要改变远端收信设置时，在 Amelu 管理界面处理。
- 待分配邮件同样遵守 `RETENTION_HOURS`。永久邮箱仅表示地址不过期，不代表邮件永久保存。
- 正文由 API 解码返回，每种正文最多 256 KB。API 暂不支持原始邮件和附件下载；原文入口会提示在 Amelu 查看，已经缓存的原文仍可查看。
- 旧连接首次成功使用 API 扫描时会清除本地凭据中的旧邮箱登录信息、重置分页位置，保留邮件和去重记录。若旧 API Key 已失效，用新 Key 重新连接即可。
- 多个来源可以同时使用。接入 Amelu 的域名由 Amelu 收信，本机 SMTP 不再接受该域名，防止绕过接入配置。

### 凭据与备份

API Key 使用 AES-256-GCM 加密后存入 `mail.db`，不会回传前端或写入代码。接入和同步不要求、不保存邮箱登录密码。首次保存连接时会在数据目录生成 `.amelu-key`。请把 **数据库和 `.amelu-key` 一起备份**，并限制数据目录权限；丢失密钥将无法解密已存凭据。也可以用固定的 `AMELU_SECRET_KEY`（64 个十六进制字符）提供加密密钥，备份恢复时必须使用同一值。

更新 API Key：再次读取域名并重新连接。不要把临时测试密钥写进环境示例或提交到代码库。网页入口应通过 HTTPS 反向代理访问，沿用原有管理员登录。

`.env.example` 仅提供变量示例，程序不会自动读取 `.env`。运行 `npm test` 验证连接恢复、鉴权、分配、分页、重复同步和删除场景。

## 操作密码（给 AI 或协作者使用）

用原主管理员密码登录后台，打开 **操作密码**，填写用途备注后点击 **创建操作密码**。可以分别为不同 AI 创建密码，单独撤销。

- 操作密码可登录同一后台，也可通过 `Authorization: Bearer <操作密码>` 或 `x-api-key: <操作密码>` 调用 API。
- 可创建、删除本站所有临时邮箱，列出邮箱、读取邮件正文和已有原文。删除邮箱会一并删除其本地邮件；仍不删除 Amelu 原件。
- 不能管理操作密码、访问 Amelu 管理接口、导入邮件或逐封删除邮件；完整权限仍属于主管理员。
- 密码自动随机生成，仅创建时返回一次。点击 **复制给 AI 的接入信息** 可一起复制站点地址、密码和常用接口。
- 数据库只保存密码哈希及用途、创建时间、最近使用时间和撤销时间，不保存明文密码。丢失后请撤销重建。
- 撤销后新请求和现有网页登录立即失效，正在等待新邮件的请求会在下次检查时停止（约 2 秒内）。不影响其他密码、邮箱或邮件。
- 重启后操作密码和撤销记录保留，浏览器需重新登录。原 `API_KEY` 仍是主管理员密码，无需更换。

管理接口（仅主管理员）：`GET /api/admin/access-passwords`、`POST /api/admin/access-passwords`（JSON：`{"label":"开发 AI"}`）、`DELETE /api/admin/access-passwords/:id`。`GET /api/admin/session` 返回当前身份及权限，不返回任何密码。

## Configuration

SnowMail is configured with environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `MAIL_DOMAIN` | `example.com` | Backward-compatible single default domain |
| `MAIL_DOMAINS` | `MAIL_DOMAIN` | Comma-separated domain allowlist |
| `DEFAULT_MAIL_DOMAIN` | first domain | Default domain selected in the admin panel |
| `SMTP_PORT` | `25` | SMTP listening port |
| `SMTP_ENABLED` | `true` | Set `false` for Amelu-only receiving, without an SMTP listener |
| `API_PORT` | `8080` | HTTP API and web UI port |
| `API_HOST` | `0.0.0.0` | HTTP bind address; use `127.0.0.1` for local checks |
| `RETENTION_HOURS` | `48` | Cleanup window for old emails |
| `CLEANUP_INTERVAL` | `10` | Cleanup interval in minutes |
| `API_KEY` | empty | Admin password and API key |
| `DATA_DIR` | project directory | Persistent directory for `mail.db` and `.amelu-key` |
| `AMELU_SYNC_SECONDS` | `15` | Delay between sync rounds, minimum 5 seconds |
| `AMELU_SECRET_KEY` | generated key file | Optional fixed 64-character hexadecimal encryption key |

Example:

```bash
MAIL_DOMAINS=example.com,example.net \
DEFAULT_MAIL_DOMAIN=example.com \
API_KEY=change-this-password \
npm start
```

## Production Setup

### systemd

Create `/etc/systemd/system/snowmail.service`:

```ini
[Unit]
Description=SnowMail
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mail-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=MAIL_DOMAIN=example.com
Environment=MAIL_DOMAINS=example.com,example.net
Environment=DEFAULT_MAIL_DOMAIN=example.com
Environment=SMTP_PORT=25
Environment=API_PORT=8080
Environment=RETENTION_HOURS=48
Environment=API_KEY=change-this-password

[Install]
WantedBy=multi-user.target
```

Start the service:

```bash
systemctl daemon-reload
systemctl enable snowmail
systemctl restart snowmail
systemctl status snowmail --no-pager
```

### Nginx

Example reverse proxy for the web UI:

```nginx
server {
    listen 80;
    server_name mail.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## DNS Setup

For each domain that should receive mail, add two records:

```text
A    mx    SERVER_IP        DNS only
MX   @     mx.example.com   Priority 10
```

Example for `example.com`:

```text
A    mx    192.0.2.10       DNS only
MX   @     mx.example.com   Priority 10
```

Keep these rules in mind:

- The `mx` A record must be DNS only. Do not proxy it.
- The web UI record, such as `mail.example.com`, may be proxied through Cloudflare or another CDN.
- MX records point to hostnames, not directly to IP addresses.
- If the server IP changes, update A records. MX records usually do not need to change.

## Web Pages

| Page | Purpose |
| --- | --- |
| `/` | Admin login page |
| `/admin` | Protected admin dashboard |
| `/verify.html` | Public page where a user enters a mailbox address |
| `/mailbox.html?address=user@example.com` | Public inbox for one mailbox |

The public pages only use `/api/public/*` endpoints and return limited mailbox data.

## API

Admin endpoints require either an admin session cookie or an API key:

```text
x-api-key: your-api-key
Authorization: Bearer your-api-key
```

Common endpoints:

```text
GET    /api/health
POST   /api/admin/login
POST   /api/admin/logout
GET    /api/config
POST   /api/generate
GET    /api/mailboxes
GET    /api/mailbox/:address
GET    /api/email/:id
GET    /api/mailbox/:address/wait?timeout=30
DELETE /api/mailboxes/:address
DELETE /api/email/:id
```

Create a mailbox:

```bash
curl -X POST https://mail.example.com/api/generate \
  -H 'content-type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{"domain":"example.com","retention_hours":24}'
```

Create a permanent custom mailbox:

```bash
curl -X POST https://mail.example.com/api/generate \
  -H 'content-type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{"custom":"demo-login","domain":"example.com","retention_hours":0}'
```

## Backup And Restore

The most important file is:

```text
/opt/mail-server/mail.db
```

When SQLite WAL files exist, keep them too:

```text
/opt/mail-server/mail.db-wal
/opt/mail-server/mail.db-shm
```

Simple backup:

```bash
cd /opt/mail-server
mkdir -p backups
cp -a mail.db mail.db-wal mail.db-shm backups/ 2>/dev/null || true
```

If `mail.db` survives, created mailboxes and old emails survive. If `mail.db` is lost, old emails are lost, but the domains can still receive new mail after DNS and SnowMail are configured again.

## Security Checklist

- Set `API_KEY` before exposing the service.
- Do not commit `mail.db`, real API keys, or private server IPs.
- Keep SMTP port `25` open only when you intend to receive email.
- Use HTTPS for the web UI.
- Remember that public mailbox pages are address-based access, not full authentication. Anyone who knows an existing mailbox address can view that mailbox through the public page.

## License

No license has been selected yet.
