<div align="center">

# SnowMail `v2.0`

**轻量级多域名临时邮箱与 AI 自动化接码服务 · 零构建毛玻璃双轨工作台**  
**Lightweight Multi-Domain Catch-All Temporary Mailbox & AI Verification Server**

[![Node.js](https://img.shields.io/badge/Node.js-20%2B-0B0E18?style=for-the-badge&logo=node.js&logoColor=CEFF1A)](#快速开始--quick-start)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-0B0E18?style=for-the-badge&logo=sqlite&logoColor=6B93FF)](#备份与恢复--backup--restore)
[![Express](https://img.shields.io/badge/REST_%2B_Long_Poll-API-0038FF?style=for-the-badge&logo=express&logoColor=FFFFFF)](#api-接口指南--rest-api)
[![Tests](https://img.shields.io/badge/Tests-31_Passing-0B0E18?style=for-the-badge)](#测试--testing)

**[简体中文](#简体中文) · [English](#english)**

</div>

---

<a id="简体中文"></a>

## 简体中文

**SnowMail** 是一款极简、零前端构建步骤的多域名临时邮箱与验证码接收服务端。只需单个 Node.js 进程与本地 SQLite（WAL 模式），即可同时支撑人工网页接码、单邮箱只读分享，以及外部脚本 / AI Agent 的高并发自动化创建与长轮询取码。

### 核心特性

| 模块 | 能力说明 |
| --- | --- |
| **双通道收信** | 支持**本机 SMTP（`:25` Catch-All 直收）**，也支持 **Amelu HTTPS 轮询同步**（无需开放服务器入站 25 端口，容器、NAT 主机与无公网 SMTP 环境均可直接运行） |
| **多域名与高并发建箱** | 支持多域名切换、自定义前缀或 12.5 亿组合高熵拟人随机地址；SQLite WAL 实测单次并发创建 35+ 邮箱仅需约 `35ms`，合法密钥调用零限流 |
| **AI 受限操作密码** | 主管理员可签发 `smop_` 前缀的独立高熵操作密码（仅存单向 SHA-256 哈希），仅授予建箱、删箱与读信权限；一键撤销后网页会话与挂起中的 `/wait` 长轮询在 2 秒内立即断开 |
| **悬浮毛玻璃双轨 UI** | 零构建原生实现流动钴蓝丝绸光带、可调透明度悬浮毛玻璃视窗（跨页面实时同步）、`58px` 独立发光图标轨、`4-8` 位验证码自动提取一键复制，以及自适应满血移动端导航坞 |
| **单邮箱公开分享** | 通过 `/verify.html` 或 `/mailbox.html?address=user@example.com` 安全分享单个邮箱收件列表（强制剥离 HTML 防注入，并内置独立访问限流） |
| **生产级安全加固** | Amelu 密钥采用 **AES-256-GCM** 认证加密落盘；内置仅统计失败次数的防爆破限流、`<iframe sandbox="">` 邮件隔离、`CSP` 安全响应头、同源 Cookie 写保护与请求头密钥鉴权 |

### 目录结构

```text
server.js                   Express HTTP 服务 + 本机 SMTP 服务 + SQLite 存储核心
lib/
  access-control.js         主管理员恒定时间校验 + smop_ 受限操作密码哈希与吊销管理
  amelu.js                  Amelu 域名探测、AES-256-GCM 凭据加密与增量分页同步引擎
private/
  admin.html                受登录会话保护的双轨毛玻璃管理后台（桌面端 + 旗舰移动端）
public/
  index.html                管理员 / 操作员登录页（支持一键切换公开邮箱快捷查询）
  verify.html               公开单邮箱地址验证入口页
  mailbox.html              公开单邮箱只读收件页（与后台实时同步视窗透明度）
  snowmail-21st.css         全局深黑曜石与电光钴蓝毛玻璃视觉系统
  snowmail-ui.js            丝绸光带着色器、追光折射按钮、零抖动橡皮筋透明度滑块与验证码识别器
  amelu-admin.js / .css     后台 Amelu 域名接入与待分配邮件管理模块
  access-passwords.js/.css  后台 AI 操作密码签发、一键复制 Agent 指引与撤销模块
test/
  access-control.test.js    权限隔离、长轮询撤销、并发 35 箱压测与防爆破集成测试
  amelu.test.js             Amelu 加密、Catch-All 防伪造路由、断点续扫与脚本语法测试
.env.example                环境变量配置模板（程序不自动读取 .env，请通过运行环境注入）
```

### 快速开始

环境要求：**Node.js 20+**（推荐 Node.js 22 LTS）。

```bash
npm install
```

#### 方式一：仅使用 Amelu HTTPS 同步收信（无需开放 25 端口，推荐）

域名需先在 [Amelu](https://app.amelu.org/) 添加并配好收信 DNS。启动时关闭本机 SMTP 监听：

**Linux / macOS：**
```bash
SMTP_ENABLED=false API_KEY='replace-with-a-long-random-password' npm start
```

**Windows PowerShell：**
```powershell
$env:SMTP_ENABLED = 'false'
$env:API_KEY = 'replace-with-a-long-random-password'
npm start
```

启动后访问 `http://127.0.0.1:8080` 登录后台，点击左侧地球图标进入 **Amelu 邮局接入**：
1. 粘贴具备邮箱管理与读信权限的 Amelu API Key，点击 **读取域名**。
2. 选择域名并检查 DNS 与现有 Catch-All 状态（若尚无 Catch-All，确认后会自动创建专用汇集邮箱并设为 Catch-All；若已有独立邮箱 Catch-All 则直接沿用，不修改现有设置）。
3. 选择收件分配方式：
   - **每封确认后分配（默认 `review`）**：适合多人严谨隔离，未确认归属的邮件先进入后台「待分配邮件」。
   - **按邮件标注自动分配（`headers`）**：适合个人或 AI 脚本批量自动化接码；当 `To/Cc/Bcc` 中恰好匹配一个本域名下已创建且未过期的临时地址时自动入箱。

#### 方式二：使用本机 SMTP（`:25` 端口直收）

服务器需具备入站 `25` 端口权限，并将域名的 `MX` 记录指向服务器：

```bash
MAIL_DOMAINS=example.com,example.net \
DEFAULT_MAIL_DOMAIN=example.com \
SMTP_ENABLED=true \
SMTP_PORT=25 \
API_PORT=8080 \
API_KEY='replace-with-a-long-random-password' \
npm start
```

### 环境变量配置

| 变量名 | 默认值 | 说明 |
| --- | --- | --- |
| `API_KEY` | 空（必填） | 主管理员登录密码与最高权限 API Key（建议 24 位以上随机字符串） |
| `API_PORT` | `8080` | Web 界面与 HTTP API 监听端口 |
| `API_HOST` | `0.0.0.0` | HTTP 绑定地址；若本机反代可设为 `127.0.0.1` |
| `SMTP_ENABLED` | `true` | 设为 `false` 时关闭本机 25 端口监听，仅通过 Amelu 收信 |
| `MAIL_DOMAINS` | `example.com` | 本机 SMTP 允许接收的域名列表（英文逗号分隔，兼容旧变量 `MAIL_DOMAIN`） |
| `DEFAULT_MAIL_DOMAIN` | 首个域名 | 后台默认选中的发号域名 |
| `SMTP_PORT` | `25` | 本机 SMTP 监听端口 |
| `RETENTION_HOURS` | `48` | 邮件正文自动清理保留时长（小时） |
| `CLEANUP_INTERVAL` | `10` | 过期邮箱与过期邮件定时巡检间隔（分钟） |
| `DATA_DIR` | 项目根目录 | `mail.db` 与 `.amelu-key` 的持久化存放目录 |
| `AMELU_SYNC_SECONDS` | `15` | Amelu 轮询间隔秒数（最小 `5` 秒） |
| `AMELU_SECRET_KEY` | 自动生成文件 | 可选的 64 位十六进制密钥；不填则在 `DATA_DIR/.amelu-key` 自动生成 |
| `TRUST_PROXY` | `loopback` | 反向代理信任策略（默认仅信任本机 Nginx / Tunnel 回环转发，防公网伪造 IP） |
| `AUTH_MAX_FAILURES_PER_MIN` | `15` | 单 IP 每分钟允许的最大密码输错次数（合法密钥请求不受任何次数限制） |

### API 接口指南（AI Agent 与脚本自动化）

所有管理与自动化接口均需通过 **HTTP 请求头**携带主管理员密码或 `smop_` 操作密码（出于安全考虑，已禁用 URL `?key=` 明文传参）：

```http
Authorization: Bearer <API_KEY 或 smop_操作密码>
# 或
x-api-key: <API_KEY 或 smop_操作密码>
```

常用接口：

```text
GET    /api/health                              服务在线与运行时长探针（公开）
GET    /api/config                              获取可用收信域名列表
POST   /api/generate                            创建随机或自定义前缀临时邮箱
GET    /api/mailboxes                           列出全部临时邮箱及各自收件数
GET    /api/mailbox/:address                    获取指定邮箱的邮件列表
GET    /api/mailbox/:address/latest             获取指定邮箱最新一封邮件详情
GET    /api/mailbox/:address/wait?timeout=30    阻塞长轮询等待新邮件（收到即刻返回正文）
GET    /api/email/:id                           按邮件 ID 读取完整文本与 HTML
DELETE /api/mailboxes/:address                  删除指定邮箱及其全部本地邮件
```

一键创建邮箱并阻塞等待新验证码邮件示例：

```bash
# 1. 创建 24 小时有效的随机临时邮箱
curl -X POST https://mail.example.com/api/generate \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer smop_your_operator_password' \
  -d '{"domain":"example.com","retention_hours":24}'

# 2. 长轮询等待该邮箱收到新邮件（最长挂起 60 秒）
curl "https://mail.example.com/api/mailbox/alex.chen.8k4m%40example.com/wait?timeout=60" \
  -H 'Authorization: Bearer smop_your_operator_password'
```

### 生产环境部署与备份

#### Nginx 反向代理参考

```nginx
server {
    listen 443 ssl http2;
    server_name mail.example.com;

    # SSL 证书配置略

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 320s;
    }
}
```

> `proxy_read_timeout 320s` 可确保 `/api/mailbox/:address/wait` 长轮询连接不会被反向代理提前切断。

#### 备份、恢复与忘记主密码重置

持久化状态仅包含 `DATA_DIR` 下的以下文件（请务必**同时备份数据库与密钥文件**）：
- `mail.db`、`mail.db-wal`、`mail.db-shm`
- `.amelu-key`（若未通过环境变量固定指定 `AMELU_SECRET_KEY`）

主管理员可在后台「密钥」页随时在线修改主密码（仅以加盐哈希存入数据库，修改后其他设备旧会话立即失效）。若日后忘记在网页修改过的主密码，可在服务器项目目录执行以下命令**免重启即时恢复**（不影响任何邮箱与邮件数据）：

```bash
# 恢复为服务器环境变量 API_KEY 初始密码
npm run reset-password

# 或直接强制重设为指定新主密码
npm run reset-password -- "your-new-strong-password"
```

### 测试

运行内置全量单元测试与真实子进程鉴权 / 并发压测套件：

```bash
npm test
```

---

<a id="english"></a>

## English

**SnowMail (`v2.0`)** is a lightweight, zero-build multi-domain temporary mailbox and verification catch-all server built with Node.js, Express, and SQLite (WAL). It provides a protected glassmorphic admin workspace, shareable read-only single-inbox pages, and high-concurrency REST + long-polling APIs tailored for AI agents and automated test suites.

### Key Highlights

- **Dual Mail Transport**: Receive mail directly via the built-in **SMTP server (`:25` catch-all)** or via **Amelu HTTPS synchronization** (outbound HTTPS only—no inbound port `25` required, ideal for containers, PaaS, and NAT environments).
- **High-Concurrency Mailbox Creation**: Multi-domain picker, custom prefixes, or high-entropy human-readable local-parts (`1.25B+` combinations). Sustains 35+ concurrent `POST /api/generate` calls in `~35ms` with zero rate-limiting on valid keys.
- **Scoped AI Operator Passwords (`smop_`)**: Issue independent, revocable 256-bit operator tokens stored solely as SHA-256 hashes. Operators can create/delete temporary mailboxes and read/wait for messages without accessing Amelu configuration or master admin controls. Revocation terminates browser sessions and in-flight `/wait` requests within 2 seconds.
- **Zero-Build Floating Glass UI (`v2.0`)**: Animated cobalt silk-ribbon `<canvas>` backdrop, live elastic glass opacity synced across tabs, `58px` dual-rail navigation, automatic `4-8` digit OTP code extraction, `<iframe sandbox="">` isolated HTML preview, and a full-featured mobile glass dock.
- **Hardened by Default**: AES-256-GCM encrypted upstream credentials at rest, failure-only brute-force protection, loopback-scoped `TRUST_PROXY`, header-only API authentication, `CSP` + `X-Frame-Options: DENY`, and same-origin CSRF checks on cookie mutations.

### Quick Start

Requires **Node.js 20+** (Node.js 22 LTS recommended).

```bash
npm install

# Start in Amelu-only mode (no port 25 listener required)
SMTP_ENABLED=false API_KEY='replace-with-a-long-random-password' npm start
```

Open `http://127.0.0.1:8080` to sign in with `API_KEY` (or a `smop_` operator password).

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `API_KEY` | empty (required) | Master admin password & full-privilege API key |
| `API_PORT` | `8080` | HTTP server & Web UI port |
| `API_HOST` | `0.0.0.0` | HTTP bind address (`127.0.0.1` recommended behind local reverse proxy) |
| `SMTP_ENABLED` | `true` | Set `false` to disable local SMTP listener and use Amelu HTTPS sync only |
| `MAIL_DOMAINS` | `example.com` | Comma-separated domain allowlist for local SMTP (`MAIL_DOMAIN` also supported) |
| `DEFAULT_MAIL_DOMAIN` | first domain | Default domain selected in the workspace |
| `SMTP_PORT` | `25` | Local SMTP listening port |
| `RETENTION_HOURS` | `48` | Retention window in hours before old messages are purged |
| `CLEANUP_INTERVAL` | `10` | Background cleanup interval in minutes |
| `DATA_DIR` | project root | Directory storing `mail.db` and `.amelu-key` |
| `AMELU_SYNC_SECONDS` | `15` | Polling delay between Amelu sync cycles (minimum `5`) |
| `AMELU_SECRET_KEY` | `.amelu-key` file | Optional 64-char hex key for AES-256-GCM credential encryption |
| `TRUST_PROXY` | `loopback` | Express `trust proxy` policy (`loopback` trusts local Nginx/cloudflared) |
| `AUTH_MAX_FAILURES_PER_MIN` | `15` | Max failed password/key guesses per IP per minute (valid keys are never throttled) |

### REST API

Authenticate all non-public `/api/*` requests via HTTP headers (`?key=` query strings are disabled to prevent log leakage):

```http
Authorization: Bearer <API_KEY or smop_password>
x-api-key: <API_KEY or smop_password>
```

Run the full test suite (`31` unit & integration tests):

```bash
npm test
```
