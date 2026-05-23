# SnowMail

SnowMail is a lightweight catch-all temporary mailbox service. It receives mail for one or more domains, stores messages in SQLite, and provides a web admin panel plus a small public mailbox viewer for sharing a single mailbox.

## Features

- Catch-all SMTP receiver for configured domains
- Multi-domain mailbox creation
- Admin login with server-side session cookie
- API key protection for admin APIs
- Public mailbox pages for one-address sharing
- SQLite storage with WAL mode
- Mailbox expiration options, including permanent mailboxes
- Basic public API rate limiting
- Simple dark web UI

## Project Structure

```text
server.js            Express API + SMTP server + SQLite storage
public/index.html    Admin login page
public/verify.html   Public mailbox verification page
public/mailbox.html  Public single-mailbox inbox page
private/admin.html   Admin dashboard, served only after login
mail.db              Runtime database, created on the server
```

`mail.db` is not part of the repository. It is the important runtime data file that contains created mailboxes and received emails.

## Requirements

- Node.js 18+
- A server with port `25` open for SMTP
- A domain managed in DNS
- Optional but recommended: Nginx reverse proxy for the web UI

Install dependencies:

```bash
npm install
```

Start locally:

```bash
npm start
```

## Environment Variables

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
MAIL_DOMAINS=dart.lat,example.com,example.net \
DEFAULT_MAIL_DOMAIN=dart.lat \
API_KEY=change-this-password \
npm start
```

## Deployment With systemd

Example service file:

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
Environment=MAIL_DOMAIN=dart.lat
Environment=MAIL_DOMAINS=dart.lat,example.com,example.net
Environment=DEFAULT_MAIL_DOMAIN=dart.lat
Environment=SMTP_PORT=25
Environment=API_PORT=8080
Environment=RETENTION_HOURS=48
Environment=API_KEY=change-this-password

[Install]
WantedBy=multi-user.target
```

Reload and start:

```bash
systemctl daemon-reload
systemctl enable snowmail
systemctl restart snowmail
systemctl status snowmail --no-pager
```

## Nginx Reverse Proxy

Example site config for the web UI:

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

For every domain that should receive email, create two DNS records:

```text
A    mx    SERVER_IP      DNS only
MX   @     mx.example.com Priority 10
```

Example for `example.com`:

```text
A    mx    192.0.2.10       DNS only
MX   @     mx.example.com   Priority 10
```

Important:

- The `mx` A record must be DNS only, not proxied.
- The web UI record, such as `mail.example.com`, can be proxied if it points to Nginx.
- MX records point to hostnames, not directly to IP addresses.

## Admin UI

Open the web UI:

```text
https://mail.example.com/
```

If `API_KEY` is configured, the first page is an admin login page. After login, the dashboard is available at:

```text
/admin
```

The admin dashboard can:

- Create mailboxes
- Select mailbox domain
- View all mailboxes
- View received emails
- Delete mailboxes and emails
- Show API endpoint examples

## Public Sharing Pages

SnowMail includes public pages for sharing access to one mailbox without showing the full admin dashboard.

```text
/verify.html
/mailbox.html?address=user@example.com
```

The public pages only use `/api/public/*` endpoints and return limited mailbox data.

## API

Admin endpoints require either a logged-in admin session cookie or an API key:

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
DELETE /api/mailboxes/:address
DELETE /api/email/:id
GET    /api/mailbox/:address/wait?timeout=30
```

Create a mailbox:

```bash
curl -X POST https://mail.example.com/api/generate \
  -H 'content-type: application/json' \
  -H 'x-api-key: your-api-key' \
  -d '{"domain":"example.com","retention_hours":24}'
```

Create a custom mailbox:

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

When using SQLite WAL mode, also keep these files if they exist:

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

If a server IP changes, update DNS A records from the old IP to the new IP. The database does not need to change.

## Security Notes

- Always set `API_KEY` on a public server.
- Do not commit `mail.db` or real API keys to Git.
- Keep SMTP port `25` open only if you intend to receive email.
- Public mailbox pages are not private authentication. Anyone who knows an existing mailbox address can view that mailbox through the public page.
- Use HTTPS for the web UI when possible.

## License

No license has been selected yet.
