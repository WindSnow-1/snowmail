<div align="center">

# SnowMail

**A lightweight catch-all mailbox server for temporary inboxes, multi-domain testing, and shareable single-mailbox pages.**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-233047?style=for-the-badge&logo=node.js&logoColor=8ee29b)](#requirements)
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
| Mail receiving | Catch-all SMTP receiver for every configured domain |
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
public/index.html    Admin login page
public/verify.html   Public mailbox verification page
public/mailbox.html  Public single-mailbox inbox page
private/admin.html   Admin dashboard, served only after login
mail.db              Runtime database, created on the server
```

`mail.db` is not committed to Git. It is the runtime database that contains created mailboxes and received emails.

## Requirements

- Node.js 18+
- A server with port `25` open for SMTP
- At least one domain you can configure with DNS
- Optional but recommended: Nginx in front of the web UI

Install and start:

```bash
npm install
npm start
```

## Configuration

SnowMail is configured with environment variables.

| Variable | Default | Description |
| --- | --- | --- |
| `MAIL_DOMAIN` | `dart.lat` | Backward-compatible single default domain |
| `MAIL_DOMAINS` | `MAIL_DOMAIN` | Comma-separated domain allowlist |
| `DEFAULT_MAIL_DOMAIN` | first domain | Default domain selected in the admin panel |
| `SMTP_PORT` | `25` | SMTP listening port |
| `API_PORT` | `8080` | HTTP API and web UI port |
| `RETENTION_HOURS` | `48` | Cleanup window for old emails |
| `CLEANUP_INTERVAL` | `10` | Cleanup interval in minutes |
| `API_KEY` | empty | Admin password and API key |

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
