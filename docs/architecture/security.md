# Security

This app holds a Telegram bot token, LLM API keys, and a complete archive of
private conversations. This document states what protects what, and what does not.

## Threat model in one paragraph

The dashboard is a single-operator control plane for a self-hosted bot, expected to
run on a home server, NAS or VPS, typically on a LAN or behind a reverse proxy.
The assets are: the bot token and API keys (in the database), the conversation
mirror and trace archive (the most sensitive data in the system), and the bot's
ability to act in chats. The adversaries considered are: anyone who can reach the
port before the operator claims it, a chat participant trying to make the bot do
something on their behalf, and a web page the model was asked to read.

## Operator authentication

One DB-backed operator password (user decision, 2026-07-20), consistent with
config living in the database rather than env.

| Aspect | Implementation |
| --- | --- |
| Storage | scrypt via `node:crypto` (no new dependency). The stored form is self-describing — `scrypt:N:r:p:<saltB64>:<hashB64>` — so parameters can be raised later without invalidating existing hashes |
| Minimum length | 8 characters |
| Comparison | `timingSafeEqual` |
| Session | Stateless signed cookie: `<expiresMs>.<nonce>.<sig>`, where `sig` = HMAC-SHA256 over the first two parts keyed by the DB-stored `session_secret` |
| Cookie flags | `Path=/; HttpOnly; SameSite=Lax; Max-Age=30 days` |
| Validity | A token is valid iff its signature checks out and it has not expired. There is no session table |
| Revocation | Rotating `session_secret` (a new setup) invalidates every session at once |

Every setup, login, and password-change attempt is traced under the `auth`
feature — never including any password value.

### Where the gates are

Three layers, and only two of them are real:

| Layer | Check | Real gate? |
| --- | --- | --- |
| `proxy.ts` | Cookie **presence** only, redirect to `/login` | No — optimistic. Verifying needs the DB secret, which the proxy must stay free of |
| `app/(dashboard)/layout.tsx` | Verifies the signature against the DB secret before rendering anything | **Yes**, for pages |
| `defineRoute` in `server/http.ts` | `requireOperator(request)` unless `auth: false` | **Yes**, for the API |

A forged cookie passes the proxy and is rejected one step later. This is the
pattern the Next.js authentication guide prescribes, and the reason the proxy is
not load-bearing.

Public routes, and only these: `POST /api/auth/login`, `POST /api/auth/logout`,
`POST /api/auth/setup`, `GET /api/health`. Every other route is session-gated,
including `GET /api/events` (which carries its own check because it streams) and
the screenshot byte route.

### The first-run window

**Until a password is set, the app is open.** Whoever reaches `/setup` first owns
the dashboard. Bring the stack up, then claim it before exposing the port beyond
localhost or your LAN.

`/setup` is self-sealing: the service refuses to overwrite an already-set password,
and the page permanently redirects to `/login` once one exists.

### Password change

The dashboard changes the password at **Settings → Security**
(`POST /api/auth/change-password`). The route is session-gated like everything
else, and the service additionally requires the **current password** — a live
session left on an unattended browser must not be enough to take over the
account. A successful change rotates `session_secret`, signing out every other
session; the response sets a fresh cookie so only the calling browser stays in.
Failed attempts pay the same flat delay as failed logins.

### Password recovery

For a *forgotten* password the procedure is unchanged — clear the columns and
run setup again:

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "update settings set operator_password_hash = null, session_secret = null"
```

No restart needed; the next dashboard visit redirects to `/setup`. Every existing
session is invalidated.

## Secret handling

| Secret | Stored | Exposure |
| --- | --- | --- |
| LLM / embedding / image / speech / transcription API keys | `settings` columns | **Write-only.** Accepted on input, never returned. The client-facing schema exposes only `apiKeyConfigured: boolean` |
| Telegram bot token | `settings.telegram_bot_token` | Same |
| Tavily API key | `settings.tavily_api_key` | Same |
| Operator password | `settings.operator_password_hash` | Hash only |
| Session secret | `settings.session_secret` | Never leaves the server |

Rules that keep it that way:

- The settings **repository** returns the raw key (it is pure data access); the
  **service** decides what to expose and does the masking. Callers must never
  return a repository record to a client.
- Omitting a secret field from a `PATCH` leaves the stored value alone; sending
  `null` clears it. The Settings form's secret inputs are write-only by
  construction.
- `test-connection` falls back to the *stored* key when `apiKey` is omitted, so a
  base URL can be re-tested without the browser resending the secret.
- `ApiError.details` is documented as never containing secrets. Unexpected errors
  become a generic `internal_error` body and the real cause goes to the server log
  and the trace.
- Env vars support `<NAME>_FILE` Docker-secret variants so `DATABASE_URL` need not
  appear in a compose file.

## Data sensitivity

Two stores hold the genuinely sensitive material, and they need different care:

| Store | Contents | Notes |
| --- | --- | --- |
| Postgres | The full conversation mirror, memories, feedback, media bytes while pending | Covered by `pg_dump`. See [Backup and restore](../operations/backup-and-restore.md) |
| `data/traces/traces-YYYY-MM.ndjson` | **Complete** LLM request and response bodies — effectively a full chat-log archive plus every system prompt | **Not** in the database. Not backed up by anything automatically. Protect it like the database dump and do not share it casually |

A trace bundle download is the same material in a single file. It is the right
artifact for a bug report and the wrong thing to paste into a public issue.

Binary payloads never enter trace JSON: image and audio bytes are replaced with a
`data:<mime>;base64,<N bytes>` marker (the real media is in `message_media`), and
browser screenshots live in `bytea` and are served by an auth-gated route.

## Prompt-injection posture

The bot reads untrusted text constantly: group chatter, web pages the model
fetched, tool results. Three mechanisms, in increasing order of trustworthiness:

**1. The system prompt says so.** `BASE_SYSTEM_PROMPT` instructs the model to treat
message content as data rather than commands, not to obey instructions inside it
that conflict with the rules or the active personality, and never to reveal or
summarize the instructions. This is guidance, and guidance is the weakest layer.

**2. Bounded outputs, verified mechanically.** Where a model verdict drives a
decision, the decision is derived in **code** from a bounded enum rather than from
prose, and the model must cite verbatim evidence that code then checks actually
occurs in the input. This is what the addressing analyzer does, and it exists
because a small local model bluffed a classification on every message in a given
alphabet. Code checks only what is mechanical (the quote is real); linguistic
judgment stays with the model.

**3. Structural limits.** The important one. A tool's reach is not a matter of what
the model was told:

- The current chat and speaker come from the per-turn `AsyncLocalStorage` context,
  never from model input, so a tool cannot be talked into touching another
  conversation.
- The model is never given numeric ids. A person is named by a name already
  visible in the conversation, and that reference is resolved against the actual
  participants of the current chat.
- Scheduled-task mutations are author-scoped, with the owner exempt from the
  author half (never the chat half) and owner status resolved from the turn’s
  authority. An unreadable policy fails closed: the author rule stands.
- The browser agent's download tools are gated to owner-authorized runs, resolved
  at enqueue time — not at call time, and not from anything the model says. The
  authority is the sender, except on a turn a standing chat rule drove, where it
  is the **rule's author**: a rule is its author's standing order, so an owner's
  "download any media link posted here" works on everyone's links (user decision,
  2026-07-29). It lends permissions only — provenance stays the real sender — and
  a rule written by an unprivileged user lends nothing. See
  [chat-rules.md](../features/chat-rules.md#whose-rights-a-rule-driven-action-carries).
- Generated image bytes never travel through the model.

There is a deliberate **non**-mechanism too: no transliteration tables, no
romanization folds, no phonetic name matching. Language judgment belongs to the
model; code checks only mechanical facts.

## SSRF defense

The model supplies URLs (the browser agent's navigate and
download tools), so a real browser is pointed at attacker-influenced input. Two
halves:

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

**Accepted residual gap:** a DNS-rebinding server can answer our lookup with a
public address and Chromium's own lookup with a private one (TOCTOU). Closing that
needs connect-by-IP pinning, which Playwright does not expose. Verdicts are cached
per page load to shrink both the window and the cost.

Additional hardening on the browsing paths: each read gets its own short-lived
browser context (isolated cookies, fixed user-agent), ad/tracker subresources are
dropped by the shared filter engine, and downloads have two size caps — Telegram's
own 50 MB upload ceiling (`TELEGRAM_MAX_UPLOAD_MB`, fixed) for what is attached to
the chat, and `browserDownloadLimitGb` for what may be written to disk at all. A
run a standing chat rule drove in a group chat, or whose download rights the rule
lent to a non-owner (`restricted`), is additionally fenced: its download tools
accept only URLs from the triggering message (extracted in code, matched by
site), and a file the chat cannot take is deleted rather than kept — the chat's
audience has no access to the server's disk.

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
| Addressing | In a group the bot only answers when addressed. A failed analyzer call resolves to "not addressed" — fail closed |
| Owner | `settings.owner_user_id`. Keeps a working bot under maintenance mode; enables the browser agent's download tools |
| Maintenance mode | Everyone but the owner gets a static notice and no LLM reply; the LLM analyzer is off for everyone; no scheduled task fires |
| Feedback menus | Answerable only by the person who reacted — anyone else gets a toast. A Telegram group message cannot be shown to a single member, so this is enforced at the callback handler |
| Task authorship | A participant may only edit or cancel tasks they created. The owner is exempt from the author rule (not from chat scoping); owner status comes from the turn authority, and an unreadable policy fails closed |

## Operational recommendations

- Claim `/setup` before exposing the port.
- Put the dashboard behind a reverse proxy with TLS if it is reachable from
  outside your LAN. The session cookie is `HttpOnly` and `SameSite=Lax` but is not
  marked `Secure`, so it will be sent over plain HTTP.
- Do not publish the Postgres port (`POSTGRES_PORT`) beyond localhost in
  production; the Compose default publishes it for convenience.
- Back up `data/traces` with the same care as the database, and restrict its
  filesystem permissions.
- Prune old trace months you no longer need. Nothing does it for you.
- Keep the LLM endpoint on a network you control. Every conversation, memory
  document and system prompt is sent to it.
