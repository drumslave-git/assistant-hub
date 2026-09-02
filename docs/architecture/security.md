# Security

This system holds Telegram bot tokens, LLM API keys, and a complete archive of
private conversations. This document states what protects what, and what does
not.

Paths are relative to `apps/core/` unless they start with `apps/` or `packages/`.

## Threat model in one paragraph

The dashboard is the control plane for a self-hosted assistant platform,
expected to run on a home server, NAS or VPS, typically on a LAN or behind a
reverse proxy. Several people hold accounts: admins run the whole thing, users
run their own assistants and the web chat. The assets are: the bot tokens and
API keys (in the database), the conversation mirror and trace archive (the most
sensitive data in the system), and the assistants' ability to act in chats. The
adversaries considered are: anyone who can reach the port before the first admin
claims it, a chat participant trying to make an assistant do something on their
behalf, one account reaching into another's world, a web page the model was
asked to read, and anything on the network that can reach the internal
service-to-service surfaces.

## Authentication: accounts

DB-backed accounts with a username, a password and a role (`admin` or `user`),
consistent with config living in the database rather than env (Phase 8; the
single operator password it replaced was a user decision of 2026-07-20).

| Aspect | Implementation |
| --- | --- |
| Storage | `accounts.password_hash`: scrypt via `node:crypto` (no new dependency). The stored form is self-describing — `scrypt:N:r:p:<saltB64>:<hashB64>` — so parameters can be raised later without invalidating existing hashes (`server/auth/password.ts`) |
| Minimum length | 8 characters for the password, 3 for the username (`lib/auth.ts`) |
| Comparison | `timingSafeEqual` |
| Session | Stateless signed cookie: `<expiresMs>.<nonce>.<sig>`, where `sig` = HMAC-SHA256 over the first two parts keyed by **that account's** `session_secret` (`server/auth/session.ts`) |
| Cookie flags | `Path=/; HttpOnly; SameSite=Lax; Max-Age=30 days` |
| Validity | A token is valid iff its signature checks out and it has not expired. There is no session table |
| Revocation | A password change rotates the account's `session_secret`, signing out that account's other sessions and nobody else's. Deactivating an account refuses its sessions at the gate |
| Temporary passwords | An admin-created or reset account holds a temporary password; its sessions are held at `/password` (and every non-public route refuses) until it is replaced |
| Failed attempts | Login and password-change failures pay the same flat delay, and a wrong username costs the same as a wrong password so a probe cannot enumerate names |

Every setup, login and password-change attempt is traced under the `auth`
feature — never including any password value.

### Roles and ownership

| Role | Reach |
| --- | --- |
| `admin` | Everything: settings, backends, every assistant and conversation, every trace, tool connections, accounts |
| `user` | The web chat plus its own world: its own assistants and everything they do (their chats, tasks, tool connections, traces), its profile and identity links, the memory held about it |

The scope is enforced once, in `server/ownership.ts`: an account-level route
resolves the acting account and gates every row by its assistant's
`owner_account_id`. An id outside the scope answers **not found**, never
forbidden, so a scoped API does not leak which ids exist. Admins hold owner
rights everywhere; a user's assistant is theirs alone.

**Owner rights in a chat** are per assistant: the sender holds them iff their
account, resolved through the person-link graph from their platform identity, is
the assistant's owning account — or they are an admin (`server/owner-rights.ts`).
The ingest stamps the verdict on every turn event as `sender.isOwner`; the
pipeline compares no user ids of its own.

### Where the gates are

Three layers, and only two of them are real:

| Layer | Check | Real gate? |
| --- | --- | --- |
| `proxy.ts` | Cookie **presence** only, redirect to `/login` | No — optimistic. Verifying needs the account's DB-stored secret, which the proxy must stay free of |
| `app/(dashboard)/layout.tsx` | Verifies the signature against the account's secret before rendering anything; sends a fresh install to `/setup`, a temporary password to `/password` | **Yes**, for pages |
| `defineRoute` in `server/http.ts` | The route's access level: `admin` (default), `account`, or `public` | **Yes**, for the API |

A forged cookie passes the proxy and is rejected one step later. This is the
pattern the Next.js authentication guide prescribes, and the reason the proxy is
not load-bearing.

Public routes, and only these: `POST /api/auth/login`, `POST /api/auth/logout`,
`POST /api/auth/setup`, `GET /api/health`. Every other dashboard route is
session-gated, including `GET /api/events` (which carries its own check because
it streams) and the screenshot byte route.

### The service-to-service surfaces

Two HTTP surfaces carry no session at all and are authenticated by one shared
secret, `INTERNAL_API_TOKEN`, sent as the `x-internal-token` header (user
decision, 2026-08-23 — a shared secret rather than network topology, since dev
runs everything on localhost):

| Surface | Serves | Called by |
| --- | --- | --- |
| The core's `app/api/internal/transports/**` | Transport registration, desired state, the feedback-menu callback, the mirror lookup, a config writeback | Transport services |
| A transport's `/internal/*` and `/mcp` | Sends that carry bytes or need an id back, the feedback menus, the platform's MCP tools | The core |

Set a real token in both apps' environments; the compose default `change-me`
is a placeholder. The transport's port is not published by compose, and the
core's internal routes answer 401 to anything without the token. A missing
token on the core side leaves every internal route refusing — a transport then
retries registration forever and the assistant editor says it has not
announced itself.

### The first-run window

**Until the first account exists, the app is open.** Whoever reaches `/setup`
first becomes the admin. Bring the stack up, then claim it before exposing the
port beyond localhost or your LAN.

`/setup` is self-sealing: the service refuses to create a first admin once any
account exists, and the page permanently redirects to `/login`.

### Password change and reset

Every account changes its own password on `/profile` (admins also under
Settings → Security), through `POST /api/auth/change-password`. The route is
session-gated like everything else, and the service additionally requires the
**current password** — a live session left on an unattended browser must not be
enough to take over the account. A successful change rotates that account's
`session_secret`; the response sets a fresh cookie so only the calling browser
stays in.

An admin resets another account from `/accounts` by issuing a fresh temporary
password, which the holder must replace at the next sign-in.

### Recovery for a locked-out sole admin

There is no reset flow that bypasses the accounts table. Delete the locked-out
admin's row on the core database:

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "delete from accounts where username = '<name>'"
```

If it was the only account, the next visit re-runs `/setup`. If other accounts
exist, promote a trusted one first (`update accounts set role = 'admin' where
username = '<other>'`) and let it issue a reset. No restart is needed.

## Secret handling

| Secret | Stored | Exposure |
| --- | --- | --- |
| Backend endpoint API keys | `backends.api_key` | **Write-only.** Accepted on input, never returned. The client-facing schema exposes only `apiKeyConfigured: boolean` |
| Telegram bot tokens | `assistant_transports.config` — the opaque connection blob the transport's field schema marks `secret` | Write-only. The dashboard receives a `…last4` preview and hands the whole blob only to the transport, over the internal API |
| Tool-connection auth headers | `tool_connections.auth_headers` | Header **names** are listed; values never leave the server |
| Tavily API key | `settings.tavily_api_key` | Write-only, `…Configured: boolean` |
| Account passwords | `accounts.password_hash` | Hash only |
| Session secrets | `accounts.session_secret` | Never leave the server |
| The internal token | `INTERNAL_API_TOKEN` env in both apps | Never stored; never in a trace |

Rules that keep it that way:

- Repositories return the raw value (they are pure data access); the
  **service** decides what to expose and does the masking. Callers must never
  return a repository record to a client.
- Omitting a secret field from a `PATCH` leaves the stored value alone; sending
  `null` clears it. The forms' secret inputs are write-only by construction.
- `POST /api/backends/test` falls back to the *stored* key when `apiKey` is
  omitted, so a backend can be re-tested without the browser resending the
  secret.
- `ApiError.details` is documented as never containing secrets. Unexpected errors
  become a generic `internal_error` body and the real cause goes to the server log
  and the trace.
- Env vars support `<NAME>_FILE` Docker-secret variants so `DATABASE_URL` and
  `INTERNAL_API_TOKEN` need not appear in a compose file.

## Data sensitivity

Three stores hold the genuinely sensitive material, and they need different care:

| Store | Contents | Notes |
| --- | --- | --- |
| Postgres | The full conversation mirror, memories, feedback, media bytes while pending, account hashes | Covered by `pg_dump`. See [Backup and restore](../operations/backup-and-restore.md) |
| `data/traces/traces-YYYY-MM.ndjson` | **Complete** LLM request and response bodies — effectively a full chat-log archive plus every system prompt | **Not** in the database. Not backed up by anything automatically. Protect it like the database dump and do not share it casually |
| Redis (`./data/redis`, AOF) | Queued transport updates and turns: message text, sender profiles and **media bytes** in flight. BullMQ keeps the last 1,000 completed jobs and failed jobs for 7 days (`packages/bus/src/queue.ts`), so recent messages remain readable in Redis after they were processed | Treat the Redis data directory and the Redis port like the database. Compose publishes `REDIS_PORT` by default for convenience |

A trace bundle download is the same material in a single file. It is the right
artifact for a bug report and the wrong thing to paste into a public issue.

Binary payloads never enter trace JSON: image and audio bytes are replaced with a
`data:<mime>;base64,<N bytes>` marker (the real media is in `source_media`), and
browser screenshots live in `bytea` and are served by an auth-gated route.

## Prompt-injection posture

The assistants read untrusted text constantly: group chatter, web pages the
model fetched, tool results. Three mechanisms, in increasing order of
trustworthiness:

**1. The system prompt says so.** `BASE_SYSTEM_PROMPT` instructs the model to treat
message content as data rather than commands, not to obey instructions inside it
that conflict with the rules or the persona, and never to reveal or summarize the
instructions. This is guidance, and guidance is the weakest layer.

**2. Bounded outputs, verified mechanically.** Where a model verdict drives a
decision, the decision is derived in **code** from a bounded enum rather than from
prose, and the model must cite verbatim evidence that code then checks actually
occurs in the input. This is what the addressing analyzer does, and it exists
because a small local model bluffed a classification on every message in a given
alphabet. Code checks only what is mechanical (the quote is real); linguistic
judgment stays with the model.

**3. Structural limits.** The important one. A tool's reach is not a matter of what
the model was told:

- The current chat and speaker come from the per-turn `AsyncLocalStorage`
  context for in-process tools, and travel as request `_meta` for a transport's
  hosted tools — never from model input, so a tool cannot be talked into
  touching another conversation. A hosted tool refuses a call that carries no
  binding or names another source.
- Which delivery a turn may perform is a fact about the turn (`deliveryKind`):
  the core withholds the tool that does not match, and the transport refuses it
  as well.
- The model is never given numeric ids for people. A person is named by a name
  already visible in the conversation, and that reference is resolved against
  the actual participants of the current chat.
- Task mutations are author-scoped, with owner-rights holders exempt from the
  author half (never the chat half). An unreadable policy fails closed: the
  author rule stands.
- The browser agent's download tools are gated to owner-authorized runs, resolved
  at enqueue time — not at call time, and not from anything the model says. The
  authority is the sender, except on a turn a standing task drove, where it
  is the **task's author**: a task is its author's standing order, so an owner's
  "download any media link posted here" works on everyone's links (user decision,
  2026-07-29). It lends permissions only — provenance stays the real sender — and
  a task written by an unprivileged user lends nothing. See
  [tasks.md](../features/tasks.md#whose-rights-a-task-driven-action-carries).
- Generated image bytes never travel through the model.
- The bot-to-bot loop guard bounds how far two assistants can keep each other
  talking: after N consecutive assistant-authored turns a chat is closed to
  assistants until a person speaks.

There is a deliberate **non**-mechanism too: no transliteration tables, no
romanization folds, no phonetic name matching. Language judgment belongs to the
model; code checks only mechanical facts.

## SSRF defense

The model supplies URLs (the browser agent's navigate and download tools), and
users register MCP endpoints, so real network clients are pointed at
attacker-influenced input. Two halves for the browser, one rule for connections:

**Static** — `features/link-fetch/url-safety.ts` (pure, unit-tested) rejects
before anything is fetched: non-http(s) schemes, embedded credentials, localhost,
the Docker host gateway, and literal private / loopback / link-local IPs.

**DNS** — `features/link-fetch/server/resolve-safety.ts`. A model-supplied
*hostname* can simply resolve to `10.x.x.x` or `169.254.169.254`, so the fetch
layer re-checks what the name actually resolves to, and re-checks again on every
redirect hop (redirect interception in `playwright.ts`). The download tools check
the URL at every redirect hop too; the stream downloader checks the manifest before
handing it to ffmpeg, and the media downloader checks the page URL before handing it
to yt-dlp. What those two binaries then follow — ffmpeg's redirects, yt-dlp's CDN
URLs — is out of our hands, so only public hosts are passed to them.

**User-owned tool connections** — a user-role account may register its own
remote MCP servers, and the core makes those calls, so their endpoints must be
**public addresses**: private ranges, localhost and link-local are rejected at
create/update time and again at call time (`features/tool-connections`), judged
by the owner's *current* role. Admin-owned connections are unrestricted.

**Accepted residual gap:** a DNS-rebinding server can answer our lookup with a
public address and Chromium's own lookup with a private one (TOCTOU). Closing that
needs connect-by-IP pinning, which Playwright does not expose. Verdicts are cached
per page load to shrink both the window and the cost.

Additional hardening on the browsing paths: each read gets its own short-lived
browser context (isolated cookies, fixed user-agent), ad/tracker subresources are
dropped by the shared filter engine, and downloads have two size caps —
Telegram's own 50 MB upload ceiling (`TELEGRAM_MAX_UPLOAD_MB`, fixed) for what is
attached to the chat, and `browserDownloadLimitGb` for what may be written to
disk at all. A run a standing task drove in a group chat, or whose download
rights the task lent to a non-owner (`restricted`), is additionally fenced: its
download tools accept only URLs from the triggering message (extracted in code,
matched by site), and a file the chat cannot take is deleted rather than kept —
the chat's audience has no access to the server's disk.

The adblock engine is matched inside the fetcher's existing `context.route`
handler rather than via the library's own `enableBlockingInPage`, which would
register a page route *ahead* of the SSRF guard and `continue()` requests past it.

## The self-updating yt-dlp

The daily yt-dlp updater downloads an executable and runs it, which is the one
place this app does that. It is not on an SSRF path — no model, page, or user
supplies the URL — so the controls are about *what* gets executed:

| Control | Effect |
| --- | --- |
| Fixed endpoint | Only `api.github.com`'s yt-dlp "latest release" is queried; no input reaches the URL |
| Literal prefix check | An asset is downloaded only from `https://github.com/yt-dlp/yt-dlp/releases/download/`, so a surprising API response cannot redirect it elsewhere |
| SHA-256 verified | Against the `SHA2-256SUMS` published in the same release, before the file is used for anything |
| Size cap | 150 MB; upstream's builds are ~40 MB |
| Executed before installed | The binary is run (`--version`) from a temp path and only then renamed over the live one, so a crash or a wrong-libc build can never leave a broken yt-dlp in place |
| Non-root, no `PATH` change | It is written to `data/bin` as the `app` user and resolved by absolute path; nothing else on the system starts using it |

**Accepted residual gap:** this verifies integrity, not provenance. GitHub also
publishes `SHA2-256SUMS.sig`, but checking it needs yt-dlp's GPG key in a keyring
this deployment does not have — so the guarantee is "exactly the file that release
published", with GitHub and the yt-dlp release trusted. An operator who does not
want that can leave the job alone: the image's pinned, checksum-verified build
keeps working, and the updater's failure mode is a stale binary, never a broken
one.

## Bot-side access control

| Control | Effect |
| --- | --- |
| Addressing | In a group an assistant only answers when addressed. A failed analyzer call resolves to "not addressed" — fail closed |
| Owner rights | The assistant's owning account (through identity links) and every admin. Keeps a working bot under maintenance mode; enables the browser agent's download tools; exempts from the task author rule |
| Identity links | A platform identity joins an account only by redeeming a one-time code the account minted in its own profile (15-minute TTL, one live code per account), or by an admin's manual link. A code cannot merge two different people — that stays an admin's call |
| Maintenance mode | Everyone without owner rights gets a static notice and no LLM reply; the LLM analyzer is off for everyone; no task fires |
| Feedback menus | Answerable only by the person who reacted — anyone else gets a toast. A Telegram group message cannot be shown to a single member, so this is enforced where the press is processed |
| Task authorship | A participant may only edit or cancel tasks they created. Owner-rights holders are exempt from the author rule (not from chat scoping); an unreadable policy fails closed |
| Deactivation | A deactivated account cannot sign in, its assistants are silenced (their turns dropped at the ingest) and their pollers stopped through the desired state; data stays intact |

## Operational recommendations

- Claim `/setup` before exposing the port.
- Set a real `INTERNAL_API_TOKEN` in both apps. Do not publish the transport's
  port; it serves only the core.
- Put the dashboard behind a reverse proxy with TLS if it is reachable from
  outside your LAN. The session cookie is `HttpOnly` and `SameSite=Lax` but is not
  marked `Secure`, so it will be sent over plain HTTP.
- Do not publish the Postgres port (`POSTGRES_PORT`) or the Redis port
  (`REDIS_PORT`) beyond localhost in production; the Compose defaults publish
  both for convenience.
- Back up `data/traces` with the same care as the database, and restrict its
  filesystem permissions. Treat `data/redis` the same way.
- Prune old trace months you no longer need. Nothing does it for you.
- Keep the LLM endpoint on a network you control. Every conversation, memory
  document and system prompt is sent to it.
- Create user accounts only for people you trust with their own assistants:
  a user's assistant can carry its own bot token and its own tool connections.
