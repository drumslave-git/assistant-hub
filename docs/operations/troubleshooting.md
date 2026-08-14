# Troubleshooting

Symptom → cause → fix. Each entry names the trace or page that carries the evidence,
because guessing is exactly what the trace archive exists to avoid.

## Start here

1. **Overview** (`/`) — six real probes: database, LLM endpoint, model, bot, trace
   storage, downloads. Any red one explains most downstream symptoms.
2. **`/jobs`** — every background job's *notice* field: the reason a job is currently
   not doing its work.
3. **`/debug`** — the trace for the specific thing that went wrong. Filter by feature
   (see the table at the end of the [operator guide](operator-guide.md#debug-debug)).
4. **Server log** — the only place an unexpected `internal_error`'s real cause appears;
   the JSON body deliberately says nothing more.

---

## The bot does not reply at all

| Check | Fix |
| --- | --- |
| Overview → Telegram bot says "Not configured" | Set the bot token in Settings → Telegram |
| Says "Stopped" | Click Start on the bot control card |
| Says "Error" | Read the message. Ending in `reconnecting automatically` means the network dropped and the manager is retrying every 15s — nothing to do but restore the connection. Otherwise Telegram refused: an invalid token, or another process holding the same token's `getUpdates` lock |
| Says "Running" but nothing happens | Continue below |
| Overview → LLM endpoint is red | Fix the connection; use Settings → Test connection for the real error |
| Overview → Model says none selected | Pick one in Settings → LLM |

If the poller is running and the LLM is reachable, the message was probably not
considered addressed — next section.

Another process holding the token is a real possibility during a redeploy or if you
have a dev server and a container running against the same token. Telegram permits
exactly one `getUpdates` consumer per token; the second one errors.

## The bot ignores me in a group

Expected unless you addressed it. Check the reply trace — filter Debug to
`bot-messaging`:

| Trace state | Meaning |
| --- | --- |
| **No trace at all** | The cheap deterministic checks rejected it and no LLM was consulted. Untraced by design; that is the bulk of a group's traffic |
| A `skipped` trace with `not addressed — …` | The analyzer ran and said no. The event data shows what it was asked and what it answered |

To make it answer reliably: @mention it, reply to one of its messages, or use
`/command@botusername`.

If it *should* have recognized its name and did not, the analyzer failed closed —
either the model could not cite the word, or the citation did not survive the verifier
call, or a provider error resolved to "not addressed". The trace shows which. Also
check whether the word is on the **exclusions** list (`/self-improvement`): a previous
👎 → "Wasn't talking to you" may have filed it.

## The bot replies when nobody addressed it

Open the reply trace and read the `addressing check` event's `matchedText` — that is
the word it took for its name.

Either fix it in-chat (react 👎 → "Wasn't talking to you", which files that exact word
as an exclusion automatically), or note it and remove/keep exclusions from
`/self-improvement`.

There is deliberately no way to make this cheaper by adding a lexical filter — that was
tried and reverted, because any such gate misses real summonses in unfamiliar
spellings.

## Everyone gets a "maintenance" notice

Maintenance mode is on. Settings → Telegram → turn it off.

While it is on: only the owner gets normal replies (and only through deterministic
addressing — the LLM analyzer is off for everyone), and **no scheduled task fires**.

## A scheduled message never arrived

| Check | Fix |
| --- | --- |
| `/tasks` job card shows **paused** | Maintenance mode. Turn it off; due tasks stay due and fire then |
| Task shows `enabled: false` | Enable it |
| `nextRunAt` is null | A spent one-shot, or an incoherent schedule. Re-save it |
| `attempts` is climbing | A due one-shot keeps failing; it is capped at 5 attempts. The fire trace under `tasks` has the error |
| Time is wrong by hours | Settings → General → Timezone. Task times are wall-clock in *that* zone, not the container's `TZ` |
| Job card shows no LLM configured | A tick with no LLM is a no-op — the task fires by asking the model to write the message |

## Replies feel slow

`/analytics` → **Model performance**, at the period in question. The call-kind
breakdown separates:

| Call kind | If this dominates |
| --- | --- |
| `addressing-check` | Group traffic is generating many analyzer calls. Expected in a busy multilingual group; each undecided message costs up to two calls |
| `reply-tool-turn` | The model is doing many tool rounds. Check the reply trace for a loop — a `loopDetected` flag means the stall guard fired |
| `reply-final` | Plain inference latency. Look at p95, not the mean |

Also check that a background job is not competing:

- The **vision backfill** aborts on live traffic and only runs after ~45s of quiet, so
  it should not be the cause.
- The **daily jobs** all run at one shared time (`dailyJobsRunTime`, default `04:00`).
  If that time is during your busy hours, move it.

## Long-term recall is bad or empty

| Check | Fix |
| --- | --- |
| `/history` job card: `embeddingsConfigured` false | Configure Settings → Embeddings. Summaries are written but not embedded without it, so semantic recall is off |
| Job card shows a large `pendingDays` backlog | The nights have not caught up. "Run now" (it is fire-and-forget; watch progress live) |
| Recall returns the wrong topic | Open `/history/{chatId}` → Summaries, find the topic, and check its **message ids** against the Messages tab. A summary that misrepresents its messages is a summarization problem; check the `history-summaries` trace for that chat-day |
| A day was imported and never summarized | Import bumps the day's message count, so the due-scan re-summarizes it. Confirm the backlog count moved |

Remember the division of labour: the last 24 hours are always verbatim in the prompt.
Only older material needs recall.

## Test embeddings fails with a width error

The configured embedding model emits vectors of a different width than the stored
columns (which are fixed at 1024). Pick a model that emits 1024 — `bge-m3` and most
self-hosted embedding models do.

This is not configurable: pgvector cannot index a vector of unspecified width, so the
column type commits to a size. The probe exists precisely so this surfaces here rather
than as an opaque Postgres rejection inside a nightly job.

## The bot did not remember something

| Check | Fix |
| --- | --- |
| `/memory` pending queue has the note | Not consolidated yet. It is folded in by the nightly job; nothing pending is injected into replies |
| Nothing in the queue, and the fact was said *to* the bot | Look at the reply trace: did the model call `memory_save`? If not, the model chose not to — the tool's description is what governs that |
| Nothing in the queue, and the fact was said in group chatter | Passive extraction reads finished chat-days, so it appears after that day's nightly run. Check `pendingExtractionDays` on the job card |
| A person's document is empty though notes were consumed | Check the `memory` trace: an **empty merge is treated as a failed pass**, so the notes should still be pending. If notes were consumed but nothing was written, the trace has the model response |
| It remembered something wrong | Edit or rewrite the document on `/memory`. It is re-embedded on save |

## Images are not described

| Check | Fix |
| --- | --- |
| `/vision` shows pending rows and a growing backlog | Backfill only runs after ~45s of quiet. On a busy bot this is normal; "Run now" arms it as soon as possible |
| The `vision`/`vision-backfill` trace shows a provider error | The configured model may not be vision-capable |
| Row status is `unavailable` | The file could not be downloaded from Telegram — the token, or Telegram's file retention |
| GIF/video rows fail | `ffmpeg` is missing. The Docker image installs it; locally it must be on `PATH` |

## The browser agent fails to launch

Chromium is missing. Locally:

```bash
npx playwright install chromium
```

Or set `CHROMIUM_EXECUTABLE_PATH` to an existing browser. In the Docker image the
distro Chromium is installed and pointed at already — if it fails there, check the
image built the `apk add` layer.

Note that a Playwright/Chromium failure is confined to the run that needs it: the
package is imported lazily precisely so it cannot crash server startup.

## `npm run build` or `npm run lint` dies with EACCES on `data/pg`

Only bites **local dev that runs the bundled Postgres**, and only the local build —
the Docker image builds before any `./data` exists, and a deployment's bind mount is
outside the source tree.

Compose bind-mounts `./data/pg`, so it creates a `0700` directory owned by the
container's postgres user *inside the project*. Any directory under the project
root that the build user cannot read is fatal: several server modules do `fs` calls on
paths under `data/`, which makes Turbopack walk those
directories while building the module graph, and one unreadable entry fails the whole
build. ESLint hit the same wall until `data/**` was added to its ignore list
(2026-07-29); Turbopack has no equivalent escape hatch —
`outputFileTracingExcludes` runs later and does not help.

**Fix: give the data directory group access**, which Postgres supports natively
(`u=rwx,g=rx` is a valid mode for it, alongside `0700`). It stays exactly where it is:

```bash
sudo chgrp -R "$(id -gn)" data/pg && sudo chmod -R g+rX data/pg
```

That yields `0750` directories and `0640` files — the layout `initdb
--allow-group-access` produces. Postgres reads the mode at startup, so a running
server keeps going and picks the setting up on its next restart.

Do **not** try `chmod o+rx`: Postgres refuses to start if the data directory has any
world permission bits.

Moving the directory out of the project also works, but the path is no longer
configurable, so it would mean editing `docker-compose.yml`.

## A media download fails

| Symptom | Cause / fix |
| --- | --- |
| "needs yt-dlp, which is not installed on the server" | No yt-dlp in `data/bin` and none on `PATH`. Hit **Run now** on the yt-dlp updater card (Browser agent page, or the Jobs board) to install one; locally you can also just install yt-dlp yourself. Only `browser_download_media` needs it — the rest of the run works |
| One page fails with yt-dlp's own `ERROR:` line | That is the site's answer: private video, sign-in wall, region block, or an unsupported site. Nothing to fix here |
| **Every** media page fails to extract | A stale yt-dlp — these sites change on purpose. Check the version on the updater card and hit **Run now**; if it says "already current", upstream has not shipped a fix yet |
| The updater card says "could not reach GitHub" | The daily check needs outbound HTTPS to `api.github.com` and `github.com`. The previous binary keeps working and the next nightly run retries; nothing is lost |
| The updater card is red with "does not run on this machine" | The downloaded build does not match the container's libc or architecture. The **previous binary is untouched** — it is never replaced until the new one has run. Report the platform (`uname -m`, glibc vs musl) |
| A merged video needs a container change | Expected: `mp4` is a preference, and yt-dlp falls back to one that can hold the chosen codecs |

## A URL is rejected as unsafe

The SSRF guard refused it. It rejects non-http(s) schemes, embedded credentials,
localhost, the Docker host gateway, literal private/loopback/link-local IPs, and
hostnames that *resolve* to any of those — re-checked on every redirect hop.

This is not configurable, and should not be: the URL comes from a model, which may
have read it off an untrusted page. If you need the bot to reach something on your own
network, that is a design change, not a setting.

## Trace flush failures

A **global banner** appears above every dashboard page. This is the one failure class
that gets that treatment, because it silently destroys data: settled traces pile up in
RAM and vanish on the next restart.

| Cause | Fix |
| --- | --- |
| The bind-mounted host directory is not writable by the container's non-root `app` user | `chown` it to that user on the host side |
| Disk full | Free space, or prune old trace months from `/debug` |

`pendingCount` in the health body and on Overview tells you how many traces are
currently at risk. **Do not restart** the container to "fix" it — that is what drops
them. Fix the write path first; the probe re-checks and the banner clears.

Related: `/api/health` deliberately does **not** fail readiness on this, precisely so
an orchestrator does not restart-loop the container and destroy the buffered traces.

## Every browser-agent download fails

Overview → **Downloads** says "Not writable", the `/browser` page shows a warning
banner, and `GET /api/health` reports `checks.downloadStorage.ok: false`. The boot log
also carries a line, because the runner probes the path at startup.

| Cause | Fix |
| --- | --- |
| The bind-mounted host directory is not writable by the container's non-root `app` user | `chown` it to that user on the host side |
| `data/downloads` cannot be created — a parent is a file, or the directory is unwritable | Fix it on disk. The `detail` field carries the OS error (`ENOTDIR`, `EACCES`, …) |
| Disk full | Free space |

Browsing, reading pages and reporting all keep working — only saving a file fails.
Individual runs report it in their activity feed, so a run that needed a download shows
`ok: false` on that step with the OS error as its summary.

Note that the probe **creates the directory** if it is missing, so "not writable" means
genuinely not writable rather than merely absent.

## `GET /api/health` returns 503

The database probe failed. That is the only thing that gates readiness.

Check `DATABASE_URL`, that Postgres is up (`docker compose ps`), and that the app can
reach it. Configuration presence, trace-storage health and download-storage health in
the same body are informational and never cause a 503.

## Locked out of the dashboard

Clear the password and run setup again:

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "update settings set operator_password_hash = null, session_secret = null"
```

No restart needed; the next visit redirects to `/setup`. Every existing session is
invalidated. This is also the procedure for *changing* the password — there is
deliberately no authenticated change-password flow yet.

## `/setup` when I expected `/login`

The `operator_password_hash` column is null. Either this is a genuinely fresh install,
or the database was reset/restored from a dump taken before setup.

If it is neither, treat it as urgent: until a password is set, whoever reaches `/setup`
first owns the dashboard.

## A dashboard page looks stale

It should not — every data page live-updates over SSE.

| Check | Fix |
| --- | --- |
| The `LiveIndicator` pill shows disconnected | The SSE stream dropped. A reverse proxy buffering responses or applying a short read timeout is the usual cause; see [Deployment](deployment.md#running-behind-a-reverse-proxy) |
| The pill is paused | You (or someone) clicked it to pause refreshes. Click again |
| Connected and unpaused but stale | A genuine bug — the publisher is not emitting on that topic. Worth reporting with a trace bundle |

## An `internal_error` with no detail

By design: the JSON body says "Internal server error" and nothing else, so nothing
leaks. The real cause — including the full `cause` chain — is in the **server log**,
logged with the request path.

If the failure happened inside a traced action, the trace also carries the full error.
A throw *before* a service opens a trace leaves only the log line.

## The provider says "500 status code (no body)"

Usually a lie. The OpenAI SDK discards JSON error bodies that are not its own
`{error:{}}` shape, so a perfectly informative provider message becomes that string.

Probe the endpoint with raw `curl`/`fetch` before concluding the provider is broken. A
frequent real cause is a context overflow, which some servers report as a 400 on one
route and a 500 on another — which is why the app classifies errors by concept rather
than by exact phrasing.

## Reporting a bug

Attach:

1. The **trace bundle** for the failing action (`/debug` → the trace → Download).
2. The relevant server log lines.
3. `GET /api/health` output.
4. The version (shown on Overview, and in the health body).

The bundle contains complete conversation content and system prompts. Redact or share
it privately — do not paste it into a public issue.
