# v2 Redesign Progress

Working tracker for the redesign described in [PLAN.md](PLAN.md). Statuses:
`todo`, `in-progress`, `blocked`, `done`, `deferred` — same rules as
[TODO.md](TODO.md) (proof for `done`, blocker + next decision for `blocked`).
Per user decision (2026-08-21), redesign progress lives here, not in TODO.md.

## Current state

Phases 0 (scaffold) and 1 (schemas + migration) are done on the long-lived
`redesign` branch (created 2026-08-21 from main at the tracing-unification
commit).

**Phase 2 is DONE** (2026-08-24): `apps/core/server/telegram` is deleted,
the tg app owns everything Telegram-shaped, the core reads/writes
conversation content only through tg's internal API, and the live
end-to-end smoke passed on the operator's real bot (see the swap notes
under the Phase 2 criteria for the commit-by-commit list, and the smoke
item below for the dev-environment setup that now exists).

**Phase 3 (Assistants) is DONE (2026-08-27)** — every acceptance
criterion is met and both operator live checks passed (see below). The sequencing decisions were
answered by the user (2026-08-24): (1) the assistant-scoped brain reads
(persona by `event.assistantId`, per-assistant tasks) flip to the v2
core store in this phase — memory/settings/self-improvement stay v1
until Phase 6; (2) the bot-to-bot loop guard defaults to **N=3**;
(3) the dev core store is populated (core import run — one assistant
converted from the active personality, backends/settings/memories/
markers reconciled; the import's CJS entry needed a `main()` wrapper,
same top-level-await gotcha as the tg boot fix). The slice-D
**MCP-outbound design call is confirmed** as the REST send API +
core-side tool bindings — flag closed; Phase 5 may wrap the same
handlers in an MCP endpoint if still wanted. Acceptance criteria are
under "Phase 3 — Assistants" below. Slices A–F are done (assistants
feature, persona flip, tasks flip, per-assistant connections + the tg
UI extension, cross-feed + loop guard, aggregated directory + person
links), plus the live-test follow-up
(per-assistant DM streams + the persona identity line — see the
criteria and session log). **Slice F landed (2026-08-27)**: the
users and groups pages aggregate every source's operator listing
instead of reading the transitional shadow, curated edits are
routed by scoped ref, and person links have CRUD with memory
reading through them. With the two operator live
checks passed the same day, Phase 3 is closed. **Phase 4 (web chat) is DONE (2026-08-27)** — all six slices
(A–F) landed the same day, each with its acceptance criterion met; the
four design calls PLAN.md deferred to this phase were answered by the
user up front (chat is a Hono service with its UI in the shell; parity
scoped to memory/traces/vision/voice; voice both directions; the full
outbound port). The web chat is a real source: threads bound to an
assistant, text/image/voice in, live turn progress, replies and tools
out, memory that follows a linked person across both apps, and traces
in the one store under the turn's own correlation. Everything but the
voice REPLY (no speech endpoint in this dev environment) and the
operator's own person-link check was verified live in the dashboard.

**Phase 5 (MCP connections) is DONE (2026-08-28)** — its
three design calls were answered by the user up front and are recorded
under "Phase 5 — MCP connections" below, with PLAN.md updated in place
where they changed the target: scoping is **global / per-app /
per-assistant** (per-chat/per-user dropped; per-assistant selection
moved out of the v2 out-of-scope list), the stored snapshot is what the
prompt carries with drift reported for an explicit Apply, and the source
apps **do** expose MCP servers — the slice-D "REST + core-side bindings"
flag is closed the other way, so `reply_to_message`,
`set_message_reaction` and `send_message` move into `apps/tg` and
`apps/chat`, while deterministic reply delivery stays on the bus and
core-internal sends stay on the REST send API.

Every acceptance criterion is met (slices A–E under the Phase 5
criteria below). The toolset is no longer compiled in: connections live
in the core store, their tools are offered along the three scope
dimensions, and the source apps host their own outbound tools on their
own MCP servers.

Verified live where a live check was possible: both running source apps
answer `/mcp` (401 without the shared secret, `assistant-hub-tg` /
`assistant-hub-chat` on a tokened `initialize`), and the whole
connection lifecycle — create, discover, apply, delete — was driven
through the running dashboard against a throwaway MCP server, with all
four actions landing as `tool-connections` traces.

**Two things the operator has to do**, neither blocking:

1. **Restart the core** (`npm run dev`, or the container). The managed
   connections for tg and chat are provisioned at boot, so until the
   running process restarts, `/tools` shows no connections and a turn
   is offered no delivery or reaction tool. Nothing else needs doing:
   the reconcile creates both rows, applies their toolsets, and says in
   its trace which app did not answer.
2. **One live turn afterwards**, to see a source tool called inside a
   real turn — the one thing no test can prove, since it needs the
   model to choose the call. The reply path is otherwise unchanged.

`npm run build` was NOT run: all three dev servers were live on
3200/3210/3220 throughout, and a production build wipes `.next` under
the running core (the standing rule). Typecheck, lint and every suite
were run instead.

**The target was revised (2026-08-30, user decision)** before any
cutover ran: core and chat merge, all storage moves into one core-owned
store, tg becomes a stateless transport, and the platform gains
multi-user accounts (admin/user). PLAN.md is rewritten in place to the
new target; the full decision set is in the session log under
2026-08-30. Phases 0–5 stay `done` as as-built history — parts of what
they built (per-app stores, the source contract, the build-time UI
extensions) are deliberately superseded by phases 6–9. The cutover moved
to Phase 10.

**Phase 6 (chat dissolve) is DONE (2026-08-30, same session).** All six
slices landed: the web chat is a core feature
(`apps/core/features/web-chat`) on the core store's `web_*` tables,
`apps/chat` is deleted, and the seams did what they were built for —
`consume.ts` was not touched. Proof: repo typecheck and lint green; core
unit suite 1178 passed (the mcp-tools catalog/offering tests updated for
the in-process chat delivery tools); core integration suite 375 passed
including the new 13-test web-chat suite (store shape, posting +
enqueued event, context window, delivery handler, outbound port,
directory client, offer predicate); store migration 0006 applied to the
dev DB and the dev chat DB's rows ported (1 user, 4 threads, 35
messages, 2 media); both remaining apps boot clean under `npm run dev`
(consumers up, tg pollers running). `npm run build` was NOT run — the
dev server was live on 3200 throughout (the standing rule). Left for
the operator: one live web-chat turn in the dashboard (the dev restart
dropped the preview session, and there is no sign-in bypass by
decision), and one look at `/tools` to see `chat_reply_to_message` /
`chat_send_message` listed under "Web chat tools".

**Phase 7 (one store, stateless transports) is DONE (2026-08-30, same
session).** All six slices landed: the tg conversation store lives in
the core's generalized `source_*` tables (migration 0007), tg holds no
database at all — it registers with the core at boot, forwards every
update as transport events, performs sends, and hosts its MCP tools.
Ingest inverted (core persists, fans out from its own presence, composes
context, and feeds the untouched pipeline), the feedback machine is
core-owned, and connection config is opaque `assistant_transports` rows
rendered by schema-driven forms — `apps/tg/ui` and the whole build-time
extension registry are deleted, `TG_API_URL` is gone (base URLs come
from the registration row). Proof: repo typecheck 8/8, lint clean, core
unit 1171 + integration 396 + tg 36 all green; dev data ported (1426
messages, 13 media, 5 feedbacks, 125 summaries, 2 connections + owner
config); live boot verified — core logs "transport 'tg' registered from
http://localhost:3210", tg logs "registered with the core — 2
connection(s) desired", both pollers running. `npm run build` was NOT
run (dev server live on 3200, standing rule). Left for the operator:
one live tg turn (message a bot) — the one check that needs Telegram.

**Phase 8 (accounts) is DONE (2026-08-31).** All six slices landed in
one session, one commit per slice: accounts in the core store with
per-account signed sessions (the operator password ported to the first
admin, 'admin'); role gates on every route (`defineRoute` access
levels: admin default, `account` for the chat/profile surfaces, public
= health + auth) and on every page (the `(admin)` route group's one
layout); the `/accounts` management page (temp-password creation,
roles, deactivate, reset — self-lockout and last-admin guards);
assistant ownership + the owner-rights resolver replacing the global
owner (tg no longer stamps `isOwner`; the Settings owner picker is
gone); web user = account (`web_users` dropped, threads per account,
the chat directory lists accounts); `/profile` for every role (display
name, password, linked identities, own-memory view + delete); and the
self-link flow (one-time profile code → sent to a bot → identity joins
the account's person link, confirmed in chat, never a turn). Proof:
typecheck 8/8, lint clean, unit 1175 core + 36 tg + 15 contracts,
integration 412; migrations 0008–0011 applied to the dev store with
the operator/web-user data ported. `npm run build` NOT run (dev server
live, standing rule). Left for the operator: sign in as 'admin' with
the old password, create a user account and walk its forced password
change, and send a link code from Telegram to see the confirmation.

**Next best task: Phase 9 (user ownership)** — full-parity user
assistants (persona, bot token, tasks, tools), user-owned MCP
connections with the public-address guard, visibility scoping (own
assistants' chats/threads/tasks/traces for user accounts), offboarding
(deactivate keeps data / hard delete cascades). Write its acceptance
criteria here when it starts.

What Phase 4 deliberately did NOT do, so nobody mistakes it for
missing: web threads are absent from the summarizer, the hybrid search
index and the analytics dashboard (decision 2 — the content plane stays
telegram-only), the memory-extraction job reads telegram content only
for the same reason, and three core callers still address chats by raw
telegram id (the reaction tool's task-fire path, browser runs, timed
task fires) because their stores keep v1-shaped ids; each says so in a
comment where it resolves its port.

**Both operator live checks passed (2026-08-27, after a service
restart), verified from the traces.** Phase 3 has no open work.

1. **Two-bot DM check (slice D) — passed.** Each bot was DM'd "tell me
   about yourself" and each answered as ITS assistant ("I am Igor…" /
   "I'm a person who's quite certain about who she is…"), on its own
   correlation, with its own `botDisplayName` in the addressing verdict.
   The two streams share one chat id (a DM's chat id is the peer's
   user id) and are numbered per bot (four-digit ids on one, three-digit
   on the other): exactly the collision that used to merge them. Both
   turns' windows were empty (their historical DM traffic is older than
   24h), so the scoped read was checked against the live mirror
   instead — each assistant's window over that shared chat id returns
   only its own pair.
2. **Group check (slice E) — passed.** "Igor, ask Anna about her day"
   in the two-bot group fanned out to BOTH assistants (one inbound
   trace, `enqueued for 2 assistants`, one event id and correlation
   each), and each answered on its own name verdict, evidence included
   (`the assistant's name is spoken: "Igor"` / `… "Anna"`,
   `matchedText` populated). Igor's reply was cross-fed to Anna and
   answered; Anna's was cross-fed to Igor and answered. Attribution is
   per reader and mirror-image: Igor's transcript renders #205/#209 as
   `Anna` and its own lines as `You`, Anna's renders #202/#204 as
   `Igor` and its own as `You`. The exchange then stopped on the loop
   guard — two skipped reply traces carrying `streak`/`limit`/reason
   ("3 assistant messages in a row (limit 3) — silent until someone
   speaks", and 4 on the other branch, the documented concurrent-burst
   overshoot). 24 traces in the window, **zero errors**, and
   `turn_actions` is empty, so every turn settled — the guard's silent
   turns included.

**Telegram refuses bot-to-bot reply targets — answered by this run.**
The question the previous live test could not answer now has data: both
cross-fed replies asked to attach to the bot-authored message they
answered (#212, #213) and Telegram delivered them with nothing attached
(`replyToMessageId: null`, warned as "reply sent — Telegram did not
attach the reply target"), while every human-authored target (#211,
#1003, #620) attached fine. The readback instrumentation
(`0097168`) is what made this visible rather than a mystery, and the
mirror records what is actually in the chat. No action: the reply still
lands, and `allow_sending_without_reply` is the behavior we want.

The numbered list below records how the last Phase 2 items closed:

1. **Analytics re-route — done (`fe56e5f`).** The former flip blocker:
   every message-volume read (charts, top users, availability, the
   insight due-scan, hour transcripts, day topics) now goes through the
   tg content API (`/internal/analytics/*` + a `?date` summaries
   filter); the aggregation SQL lives tg-side pinned by a new
   integration suite, the due-scan is the summarizer's split-scan
   shape, and the core insight suite runs over the in-memory fake.
2. **Trace client over the bus — done (`8428ea7`).** The tg app records
   through the shared client in contracts (buffered whole-trace,
   published as `trace.recorded` on settle; unsettled = unpublished, so
   mirrored chatter stays silent) and the core ingests into the one
   trace store. Instrumented: inbound processing, feedback collection,
   reply delivery — each on the turn's correlation.
3. **Live end-to-end topology smoke — done (2026-08-24).** Dev topology
   stood up (databases `tg` + `core` created and migrated, `apps/tg/.env`
   written, compose Redis, shared `INTERNAL_API_TOKEN` in both `.env`
   files; tg store seeded from v1 settings — connection with the bot
   token under the active-personality assistant id, owner row) and the
   operator messaged the live bot: poller → mirror + hold → queue →
   core turn (full v1 prompt pipeline, LLM, honesty gate) → reply over
   the bus → tg send + assistant mirror row → hold released — and all
   three traces (tg `inbound`, core `reply`, tg `deliver`) landed in
   the one store under the single correlation `chat:message`, the
   cross-app trace client working live. One boot bug found only by the
   real boot (`666d133`): apps/tg needed `"type": "module"` — tsx
   inferred CJS and died on the entrypoint's top-level await, a failure
   every vitest suite masked by running the same files as ESM (the
   Docker CMD would have died identically).
   First smoke turn came back as the model's own reasoning; root cause
   found by diffing the request against a pre-swap trace: the prompt was
   byte-identical EXCEPT the history window — the fresh tg store had no
   mirror, so the turn ran with zero conversation history and gemma4-26b
   deliberated instead of replying. Resolved by running the designed v1
   import into the tg store (`import:v1`, source read-only: 1384
   messages, search index, media, summaries, feedbacks, users/chats,
   connection + owner; row counts reconciled, spot checks verbatim).
   Second live turn confirmed normal behavior by the operator. Dev note:
   the store was reset before the import (one-shot semantics), dropping
   only the two smoke rows.

The slice-C task-authority
swap blocker is resolved and landed (`ec2b7ad`): `event.sender.isOwner`
is authoritative, tasks stamp `created_by_owner` at creation (core
migration 0059 backfills), `BotPolicy` is maintenance-only.

Phase 2 mechanics decided (user, 2026-08-23): **Hono** for the tg
service's HTTP surface (operator API + MCP endpoint); the **two-step
extraction** (build apps/tg additively while core runs v1, then one swap
commit deletes `server/telegram` and re-routes its consumers); internal
core↔tg auth via a shared-secret header (`INTERNAL_API_TOKEN` on both
sides). For apps/chat the user asked whether it must be Next.js —
standing recommendation (final call at Phase 4): no; its UI renders
inside the core dashboard's Next build via `apps/chat/ui` (PLAN's
micro-frontend decision), so the chat backend is a pure service and Hono
keeps it tg's twin. A standalone chat frontend outside the dashboard
would reopen that.

The open questions were answered by the user (2026-08-22) and applied:

1. **Queue retry semantics**: confirmed — BullMQ `attempts: 1`; the turn
   runner alone decides re-enqueue via the "actions started" marker.
2. **Placement rule (strict)**: bot state (memory, self-improvement,
   tasks, job coverage markers like chat_summary_days /
   memory_extraction_days) → **core** store; conversation-derived content
   (messages, message_search, media, **chat summaries**, feedbacks) →
   the **owning app's** store — "core just provides tools and features".
   Consequence for Phase 2: core jobs (summarization, search indexing,
   vision describe) read and write app content through the owning app's
   API.
3. **Owner**: owner logic and settings live on the app side (tg-store
   settings singleton holds owner_username / owner_user_id); the core
   receives only the resolved is-owner flag on inbound events.
   `maintenance_mode_enabled` stays core (the gate consuming the flag).
4. Naming confirmed as explained: `@assistant-hub/*` package scope ahead
   of the Phase 6 repo rename; per-app v2 database modules in
   `<app>/store/`; core's transitional `STORE_DATABASE_URL`; assistants
   keep personality UUIDs.

Known pitfalls (in addition to the ones under "Phases" below):

- Local dev runtime data now lives under `apps/core/data` (traces,
  downloads, bin); only the Compose Postgres bind mount stays at the root
  `./data/pg`. The container equivalents moved to `/app/apps/core/data/*`
  because the standalone server chdirs into `apps/core`.
- `npm run <anything>` at the root fans out via turbo; per-app scripts run
  with `npm run <script> -w @assistant-hub/core`. The dev server and
  `.claude/launch.json` are unchanged (port 3200).
- `npm run dev` at the root now starts all three processes — core (3200),
  tg (3210) and chat (3220) — because each app has a `dev` script and
  turbo runs them together. The dev chat store exists (database `chat`,
  migrated, `apps/chat/.env` written, `CHAT_API_URL` in `apps/core/.env`).
- **A dev server can lose a route it once served.** `/apps/chat` 404ed on
  a freshly started dev server (2026-08-27) while the same code served it
  minutes earlier and `next build` lists `/apps/[app]/[[...rest]]` — the
  route table went stale, and a restart fixed it. The mount page now says
  "No app is mounted here" for an unknown app, so the two failures are
  distinguishable: a worded page means the registry, a bare Next 404
  means the dev server has not compiled the route — restart it.
- **A code change in the turn consumer, the prompt or a source app is not
  live until the process restarts.** They are boot-time modules: Next's
  hot reload does not reach the consumer the instrumentation started, and
  the tg/chat services are separate processes. Twice during Phase 4 an
  edit looked ineffective and the trace showed the OLD code running —
  read the trace before doubting the change.

Known pitfalls for whoever starts:

- Work happens on the long-lived redesign branch, rebased onto main after
  hotfixes — never merge commits, never version bumps from the branch.
- The dev server on :3200 and the preview browser session have the usual
  constraints (see memory/AGENTS.md); Phase 0 moves files massively — expect
  to restart the dev server deliberately, not accidentally.
- Migration work (Phase 1) must never run against the production DB except
  through the rehearsal/cutover workflow in PLAN.md.

## Phases

| Phase | Scope (see PLAN.md) | Status |
| --- | --- | --- |
| 0 | Monorepo scaffold, apps/core + packages carve-out, extension registry, CI, docker | done |
| 1 | Per-app databases + schemas, scoped refs, person links, migration scripts + rehearsal | done |
| 2 | Source split: telegram runtime out of core into apps/tg, source contract, Redis bus + queue | done |
| 3 | Assistants CRUD, per-assistant bots, tasks, addressing rules | done |
| 4 | Web chat: apps/chat + chat-ui, threads, text/image/voice, live progress | done |
| 5 | MCP connections (HTTP): CRUD, discovery, snapshot/apply, scoping | done |
| 6 | Chat dissolve: apps/chat merges into core (store, backend, tools, pages) | done |
| 7 | One store, stateless transports: tg de-stored, transport contract, self-registration, schema-driven config | done |
| 8 | Accounts: users table, roles, role gates, assistant ownership + owner rights, identity self-link, memory rescope | done |
| 9 | User ownership: full-parity user assistants, user MCP connections + public-address guard, visibility, offboarding | todo |
| 10 | Cutover: rehearsed migration, runbook, rename, release, docs | todo |

Phases 0–5 describe the as-built per-app architecture that phases 6–9
deliberately supersede (2026-08-30 revision); their criteria below are
history, not the current target.

## Phase 8 — Accounts (acceptance criteria)

Scope from PLAN.md: the accounts table, roles and per-account sessions;
first-run setup creates the first admin; account management UI; role
gates across every page and API; assistants gain owning accounts and
owner-rights resolution replaces the global owner; identity links with
the self-link bot-code flow; memory rescoped with the user-facing
view + delete.

Design fixed at open (user Q&A, 2026-08-31):

- **Accounts join the person-link graph.** An account is a new identity
  kind (`account:<id>`) inside the existing person-link mechanism; the
  self-link code just adds a membership. Memory and owner-rights resolve
  through the one graph. Non-account humans keep plain links.
- **The operator ports forward.** A one-shot dev port (and the same move
  at cutover) creates the first admin from the existing operator hash —
  the stored scrypt string is self-describing, so it copies verbatim.
- **Admin-created accounts get a temporary password** and must change it
  at first sign-in; the forced-change gate holds the session to the
  change-password surface until they do.
- **Web user = account.** Each account IS its web-chat identity
  (`chat:user:<accountId>`); threads belong to accounts; the old
  `web_users` operator row and its threads port onto the first admin.

- [x] **A — accounts + auth.** `accounts` in the core store (unique
      username, display name, aliases, scrypt hash, role admin|user,
      per-account session secret, must-change-password, active) with a
      migration; the auth service rewritten on accounts: username +
      password login, session tokens carrying the account id and signed
      per-account (a password change signs out that account only),
      first-run `/setup` creates the first admin, login/setup pages gain
      the username field; the dev port creates the first admin from the
      v1 operator hash.
- [x] **B — role gates + account management.** `defineRoute` grows an
      access level (admin-only stays the default; `account` for the
      surfaces any signed-in account may use; public stays health +
      auth) and hands the body the acting account; the dashboard layout
      resolves the account, filters nav by role, and user-role visitors
      get the chat-shaped shell; an `/accounts` admin page (create with
      temp password, role, activate/deactivate, reset password), all
      actions traced.
- [x] **C — assistant owners + owner rights.** `owner_account_id` on
      assistants (existing rows → the first admin, visible in the
      editor); the transport contract drops `isOwner` — tg stops
      stamping it, the owner fields leave tg's transport config, its
      `owner.ts`, and the Settings owner card; core ingest resolves
      owner rights per receiver instead: sender ref → link graph →
      account, owner iff that account owns the assistant or is an
      admin; the web chat resolves its sender the same way.
- [x] **D — accounts in the link graph + self-link.** `account:<id>`
      refs are valid person-link members; the directory offers accounts
      as identities; memory identity resolution follows account refs;
      the profile mints a one-time short-TTL code — sending it to any
      connected bot links that platform identity to the account (ingest
      detects it, links, confirms in the chat); admins link/unlink via
      the existing person-links UI.
- [x] **E — web chat on accounts + profile + own memory.** `web_users`
      is dropped: threads key on the account id, the operator row and
      threads ported to the first admin, the chat directory lists
      accounts; a profile page (display name, change password, linked
      identities, mint link code); every account can view and delete
      the memory documents held under its linked identities (the admin
      memory page stays global).
- [x] **F — proof.** Suites, lint, typecheck green; dev ports run;
      docs updated; live checks recorded — admin sign-in, a created
      user's forced password change, and the self-link code round-trip
      through a bot.

## Phase 7 — One store, stateless transports (acceptance criteria)

Scope from PLAN.md: the tg store moves into the core's generalized
conversation tables; tg forwards everything and hands media bytes to the
core; context composition moves into the core; connection config becomes
opaque sections on assistants with schema-driven forms replacing
`apps/tg/ui`; transport self-registration + reconcile; the transport
contract replaces the source-app contract; tg's database is deleted.

Design fixed at open (mechanical consequences of the 2026-08-30 Q&A, no
new user decisions):

- **Generalized tables** in the core store, prefixed `source_*`
  (`source_users`, `source_chats`, `source_chat_members`,
  `source_chat_assistants`, `source_messages`, `source_message_search`,
  `source_media`, `source_media_blobs`, `source_feedbacks`,
  `source_summaries`), every row keyed by `source` + source-local
  **text** ids (contract-aligned; ordering stays on the identity `id`).
  Platform stream semantics (telegram's shared group stream vs per-bot
  DM streams) reach the core as a transport-computed `dedupe_key` —
  never as a `chat_id like '-%'` in core code. The web chat's `web_*`
  tables stay as they are (unification is a later phase).
- **Ingest inversion**: the queue carries a new transport-update
  contract (message / edit / delivery / reaction / callback events, all
  media bytes attached, per-running-connection structural verdicts
  computed in tg); a core ingest stage persists, resolves the audience
  from core-owned presence, composes context, and hands the existing
  turn-event shape to the existing pipeline — `processInboundEvent`
  stays untouched. Cross-feed and the `#id` link whitelist move to the
  core (they are mirror reads); tg publishes a `message.delivered`
  event for every send and the core writes the mirror + cross-feeds.
- **Feedback machine** (flows/menus) moves into the core; tg forwards
  reaction/callback updates and serves menu send/edit/answer endpoints.
- **Registration**: a `transports` table (base URL, MCP path, config
  schemas, enabled, transport config blob) fed by tg's boot-time
  self-registration over the internal API; `TG_API_URL` in the core
  dies (the base URL comes from registration); desired state (transport
  config + per-assistant connections from the new
  `assistant_transports` table) is fetched by tg at boot and on bus
  change events. Owner identity lives in tg's transport config blob.

- [x] **A — conversation store lands in core.** The `source_*` tables +
      `transports` + `assistant_transports` in the core store schema
      with a migration; repositories ported from tg's `store.ts`,
      `media/store.ts`, `content/*`, `feedback/store.ts`; the v1 import
      (tg's `import-v1.ts`) retargeted to the core tables.
- [x] **B — core reads locally.** The per-source lookups resolve `tg`
      to core-store implementations for the directory, media
      store/browse, the content plane (messages, summaries, search,
      index, analytics), and feedbacks; `tg-content.ts` and the
      listing half of `tg-operator.ts` are deleted; a one-shot script
      ports the dev tg DB into the core store.
- [x] **C — ingest inversion.** The transport-update contract in
      `packages/contracts`; tg's inbound/cross-feed/delivery stop
      writing any store and publish updates + delivered events; the
      core ingest consumer persists, fans out (audience from core
      presence), composes context, and feeds the pipeline; reply
      deliveries carry the core-resolved link whitelist; the
      processed-hold releases core-side.
- [x] **D — feedback machine in core.** Reaction/callback/menu-reply
      updates forwarded by tg; the flow state machine ported into the
      core; menu send/edit/answer served by tg's API; the learning
      jobs read core rows directly.
- [x] **E — registration + config.** tg self-registers (id, name, base
      URL, MCP path, config schemas) against the core's internal
      transport API; connections live in `assistant_transports` with a
      schema-driven section in the assistant editor; owner identity in
      the transport config blob (with tg's resolved-id writeback);
      `apps/tg/ui` and the extension registry deleted; `TG_API_URL`
      gone; the managed MCP reconcile and every core→tg call resolve
      the base URL from the registration row.
- [x] **F — tg is stateless.** tg's database, schema, migrations, and
      drizzle config deleted; its `.env` keeps only REDIS_URL, the
      internal token, PORT, and the core's URL; compose/initdb drop the
      tg database; tests re-homed (store/content/feedback suites into
      the core; tg keeps normalization/addressing/send tests); lint,
      typecheck, suites green; both apps boot and a live tg turn works.

## Phase 6 — Chat dissolve (acceptance criteria)

Scope from PLAN.md: `apps/chat` merges into the core — its store into the
core schema, its backend in-process, its outbound MCP tools become
in-process core tools, its dashboard views become plain core pages; the
app and its queue hop are deleted. The design lever: every seam the chat
app plugged into (`sourceOutbound`, `sourceMediaStore`, the directory
client, the managed-connection reconcile, the events channel) is already
a per-source lookup, so the merge swaps the chat resolution from an HTTP
client to a local implementation and leaves the pipeline (`consume.ts`)
untouched.

- [x] **A — the store moves.** `web_users`, `web_threads`,
      `web_messages`, `web_media`, `web_media_blobs` in the core store
      schema (`apps/core/store/schema.ts`) with a migration;
      repositories ported from `apps/chat/src/{store,media}.ts` into the
      core web-chat feature; the migration also deletes the managed
      `chat` tool-connection row; a one-shot script ports the dev chat
      DB's rows into the core store; migration applied to the dev DB.
- [x] **B — local source adapters.** `sourceOutbound("chat")`,
      `sourceMediaStore("chat")` / `sourceMediaBrowse("chat")`, and the
      chat directory/operator client become in-process DB-backed
      implementations; `sourceApiConfig("chat")` resolves null (the env
      lookup keeps only tg); the aggregated users/groups pages, vision
      backfill + gallery, and conversation naming keep working through
      the local adapters.
- [x] **C — inbound in-process, delivery consumed in core.** Posting a
      thread message stores + enqueues from core server code (no HTTP
      hop; same normalized event, same queue, so ordering/retry/settle
      semantics are unchanged); the core's source-events consumer
      handles `reply.delivery` and `turn.lifecycle` for source `chat`
      (reply stored via the repository, running-turn state in a
      globalThis-pinned ThreadTurns singleton, SSE pinged in-process).
- [x] **D — delivery tools in-process.** `chat_reply_to_message` /
      `chat_send_message` become in-process registry tools offered only
      on chat-source turns and filtered by delivery kind through a
      shared offering predicate (one mechanism, no per-feature
      special-casing in the toolset service); the managed-connection
      reconcile covers only external transport sources; no stale chat
      connection row remains.
- [x] **E — UI and API local.** The `/api/chat/*` Route Handlers call
      the local service; media bytes served from the store; the threads
      page moves into the core as a plain component; the nav entry is
      native to the shell; `@assistant-hub/chat-ui` leaves the extension
      registry; chat-only DTO schemas move from `packages/contracts`
      into the core feature (cross-app event/send schemas stay).
- [x] **F — the app is deleted.** `apps/chat` removed entirely;
      `CHAT_API_URL` gone from env schema, `.env`s, and compose; root
      dev scripts / turbo / CI / docs updated (two apps now); chat's
      tests ported into the core (store integration, post-message +
      runtime integration, MCP tool behavior, operator listing,
      ThreadTurns unit); lint, typecheck, and the suites green.

## Phase 0 — Scaffold (acceptance criteria)

Scope from PLAN.md: Turborepo + npm workspaces; the current app moves into
`apps/core` unchanged; `packages/db` / `packages/contracts` / `packages/ui`
carved out with no behavior change; the extension-registry skeleton in the
shell; lint/typecheck/test/build wiring through turbo; docker builds the
per-app images (only `core` exists yet) and the release pipeline publishes
them all from one root version bump.

- [x] Root is a Turborepo workspace (`turbo.json`, root `package.json` with
      `workspaces`, shared `tsconfig.base.json`); `npm run lint|typecheck|
      test|build` at the root fan out via turbo and pass.
- [x] The whole current app lives in `apps/core` (moved with `git mv`, no
      rewrites beyond config paths); `npm run dev` still serves the
      dashboard on :3200; `@/*` imports unchanged.
- [x] `packages/db` (`@assistant-hub/db`) holds the generic Postgres/drizzle
      tooling (process-global pool singletons keyed by symbol, the
      production migration runner formerly in `docker/migrate`);
      `apps/core/db/pool.ts` consumes it with the same symbol key and
      identical behavior. App schema, drizzle handle, and migration chain
      stay in `apps/core`.
- [x] `packages/contracts` (`@assistant-hub/contracts`) exists as the
      documented home for cross-app schemas (source-app contract, scoped
      refs — content lands in Phases 1–2; deliberately exports nothing yet).
- [x] `packages/ui` (`@assistant-hub/ui`) holds the typed extension-point
      definitions (`AppExtensions` with nav contributions now; form
      sections / status cards / debug panels / aggregated views typed as
      their first contributor lands) plus `composeNavGroups`; the shell's
      `NAV_GROUPS` composes from the static registry in
      `apps/core/components/layout/extensions.ts` (empty today) — rendered
      nav identical.
- [x] Docker: `apps/core/Dockerfile` builds `assistant-hub-core` from the
      repo-root context (workspace-aware install, Next standalone monorepo
      output with `outputFileTracingRoot`, migrate runner from
      `packages/db/migrate`, runtime data at `/app/apps/core/data/*`); root
      `docker-compose.yml` and `docker-compose.test.yml` updated.
- [x] Release pipeline: `.github/workflows/release.yml` verifies via turbo
      and, on a root version change on main, tags once and builds/pushes
      every per-app image (matrix; currently `assistant-hub-core`) on that
      one version. (Cannot fire from the branch — by design, no version
      bumps until cutover; verified by review only.)
- [x] Proof (2026-08-21, all from the root): `turbo run typecheck` 4/4
      workspaces green; `turbo run lint` green; `turbo run test` 1163
      passed / 26 skipped; `turbo run test:integration` 367 passed / 33
      skipped (Testcontainers); `turbo run build` green (standalone output
      verified: `apps/core/server.js` + root `node_modules` + traced
      playwright). `docker build -f apps/core/Dockerfile .` succeeded
      (1.83GB) and the container booted: migrate runner ran (skipped
      without DATABASE_URL), standalone server started from
      `apps/core/server.js`, failed only on the intentional missing-DB
      guard — same as v1 without a database. Dev server boots through
      turbo (env loaded from `apps/core/.env`, DB + bot poller up, /login
      200, no server errors).

`npm run test:linux` verified on the new layout (stale volume dropped,
fresh workspace install, 1189/1189 tests in 105 files — including the
subprocess tests that skip on Windows).

Remaining risks: the release workflow is updated but unexercised (it can
only fire from main — by design, no version bumps from the branch until
cutover). The standalone build locally traces in `apps/core/data`
and test files — harmless in the image because `.dockerignore` excludes
them from the build context. Docs under `docs/` still describe the v1
layout except README and `docs/operations/deployment.md`, which were
updated; the full docs rewrite is Phase 6 by design.

## Phase 1 — Schemas + migration (acceptance criteria)

Scope from PLAN.md: per-app databases and schema modules (core, tg, chat);
scoped-ref and person-link foundations; migration scripts splitting the v1
DB + verification harness + rehearsal workflow. The v1 runtime keeps
running on the v1 schema untouched — the new stores exist beside it and
take over feature by feature in Phases 2–5.

Conventions set here: each app's v2 database module lives in
`<app>/store/` (schema.ts + migrations/ + drizzle config) — `apps/core/db`
stays the v1 module until cutover deletes it. Fresh databases, fresh
migration chains, clean table names. Store DB URLs come from each app's
own env (`DATABASE_URL` in apps/tg and apps/chat; `STORE_DATABASE_URL` in
apps/core while v1 still owns `DATABASE_URL`). Import scripts read the v1
DB via `V1_DATABASE_URL` with plain SQL (no code dependency on the v1
schema module) and refuse a non-empty target.

- [x] `@assistant-hub/contracts` exports the scoped-ref foundation
      (`source:kind:id` — format, parse, zod schema, source ids) and the
      shared `EMBEDDING_DIMENSIONS` constant (moved from `lib/embeddings`,
      which re-exports it); unit tests cover parse/format round-trips.
- [x] `apps/core/store`: core-store schema + 0000 migration — backends,
      settings (v1 minus `telegram_bot_token` / `active_personality_id` /
      owner columns), assistants, memory (entries / user docs by scoped
      ref / general), communication_preferences, self_corrections,
      addressing_exclusions, tasks (scoped refs + `assistant_id`), job
      coverage markers (chat_summary_days + memory_extraction_days,
      scoped chat refs), person_links + person_link_members (unique
      member ref).
- [x] `apps/tg/store`: tg-store schema + 0000 migration — users, chats,
      chat_members, messages, message_search, media, media_blobs,
      feedbacks, summaries (conversation-derived content lives with the
      mirror — user decision 2026-08-22), connections (bot token per
      assistant, desired state), settings singleton (owner identity).
      Hand-written extension/index SQL (vector, pg_trgm, FTS/trgm GIN)
      carried over from the v1 chain.
- [x] `apps/chat/store`: chat-store schema + 0000 migration — users
      (operator flag), threads (assistant bound at creation), messages,
      media + blobs.
- [x] Import scripts as one-shot per-app tools: `apps/core/store/import-v1.ts`
      and `apps/tg/store/import-v1.ts` (runnable via `npm run import:v1
      -w <app>`), splitting the v1 DB per the PLAN mapping, preserving
      identity ids, converting FKs to scoped refs, deriving the default
      assistant deterministically (active personality id, else the fixed
      `assistant-default`), and creating the tg connection from the v1
      bot token. Both refuse a non-empty target.
- [x] Verification harness built into each import script: per-table-pair
      row-count reconciliation plus spot checks; mismatch prints a report
      and exits non-zero.
- [x] Integration tests (Testcontainers): seeded synthetic v1 fixtures →
      run each import → verification passes and spot asserts hold; the
      chat store's migration chain applies cleanly.
- [x] Rehearsal workflow documented (docs/operations/v1-split.md): dump →
      restore copy → create per-app DBs (`packages/db` create-database
      helper) → migrate stores → run imports → read verification; repeat
      until clean. Production DB is never touched outside it.
- [x] Proof (2026-08-22, after the placement revision, all from the
      root): typecheck 6/6 workspaces green; lint green; unit tests green
      (contracts scoped-ref suite included); `turbo run test:integration`
      green with a real exit code — chat 1/1, tg 2/2 (full import
      round-trip: verbatim identity-preserved mirror and summaries,
      surviving embeddings and pending-media bytes, token bound to the
      converted active personality, owner in tg settings,
      non-empty-target refusal), core 369 passed / 33 skipped including
      the core import round-trip (settings minus dropped token/persona/
      owner columns, id-preserving assistants, scoped refs on
      memory/tasks/exclusions, identity-preserved day markers, sequence
      continuation, refusal); build green.

Remaining gaps, deliberate: the new workspaces (tg, chat, contracts, db,
ui) have no eslint wiring yet (typecheck guards them; lint config for
non-Next workspaces is a small standalone task). The tg import test
applies the frozen v1 migration chain via a cross-app path — test-only,
deleted with `apps/core/db` at cutover. Person links have schema +
foundations only; no UI/service until the aggregation phases.

## Phase 5 — MCP connections (acceptance criteria)

Scope from PLAN.md: HTTP tool connections CRUD, discovery +
snapshot/apply, scoping (global / per-app / per-assistant), slug
prefixing, the source apps' own MCP servers, tools dashboard rework.

Decisions (user, 2026-08-28):

1. **Scope dimensions are global / per-app / per-assistant.** A new
   connection is global (offered on every turn); an app-scoped one is
   offered only on turns from that source app — which is how each
   source's own MCP server stays out of the other's prompt — and the
   operator picks which assistants may call a connection (default: all).
   **Per-chat and per-user scoping is dropped from v2**; PLAN.md is
   updated accordingly, and per-assistant selection moved out of the
   out-of-scope list into this phase.
2. **The snapshot wins, drift is shown, a bad call is a tool error.**
   The prompt only ever carries the stored snapshot, so the offered
   toolset changes on operator command and never mid-conversation
   (prefix-cache stability, no strict-provider 400s on schema drift).
   Re-discovery diffs against the snapshot and the dashboard reports
   added / changed / removed with an explicit Apply. A server that is
   unreachable, or a tool that has vanished, returns a normal tool error
   the model can react to — the toolset is not edited by a remote
   server's uptime.
3. **Sources expose real MCP servers** — PLAN's architecture stands.
   The slice-D note ("REST send API + core-side tool bindings; Phase 5
   may wrap the same handlers in an MCP endpoint if still wanted") is
   answered: `apps/tg` and `apps/chat` each serve `/mcp`, and the core
   consumes them as connections like any other.
4. **Only model-facing outbound moves onto MCP.** Deterministic reply
   delivery keeps travelling the bus, and core-internal sends that are
   not tool calls (image-generation results, browser-agent downloads,
   media fetches) keep using the REST send API. What moves is the set of
   tools the model itself calls: `reply_to_message`,
   `set_message_reaction`, `send_message`.

Design notes settled in-session (they follow from the decisions and the
code, no user call needed):

- **Turn context travels in `_meta`, never in the tool schema.** An
  app-hosted tool has no ambient turn state, but the model must not be
  handed a chat ref to choose either. The core's connection client
  attaches the turn's binding (source, chat ref, reply target,
  assistant id, correlation id) as MCP request `_meta`; the app's
  handler reads it from the request extra. Verified against the
  installed SDK (1.29.0): `RequestHandlerExtra._meta` carries the
  originating request's metadata. A source tool that takes a chat id as
  a model-visible argument is a failed criterion — that is the
  authority hole the current bindings close.
- **Built-in feature tools keep bare names; only connection tools are
  prefixed** `<slug>__<tool>`. The prefix exists to stop collisions
  between connections; renaming `memory_save` and friends would
  invalidate stored traces, task rows and the prompt text that names
  them.
- **One resolution path.** `getToolset` returns built-ins plus every
  snapshot tool whose connection matches the turn's source and
  assistant. A second `if (source === "tg")` branch anywhere in the
  resolution is a failed criterion (the Phase 4 rule).
- **Secrets follow the backends precedent**: header values live in the
  core DB and are never returned in plaintext by the API or rendered in
  the dashboard.
- **The registry's staleness check has to survive DB-backed tools.**
  `isCurrent()` compares the cached registry's tool names against the
  names the loaded code registers; connection tools are not code, so an
  applied snapshot could stay invisible until restart — the same silent
  staleness the hot-reload check was written for. Planned as a
  connections revision in the cache key; **reversed in slice C** and
  replaced by not caching at all: the connection half is read from the
  store on every turn (two small queries next to an inference), so there
  is no cached copy to go stale and no bump for a writer to forget. The
  in-process registry keeps its own code-identity check unchanged.

Criteria:

- [x] **A — connections store, CRUD, HTTP client** (`21d5a2b`). Core migration adds
      `tool_connections` (slug, name, transport discriminator with
      `http` live and `stdio` modeled-but-refused, endpoint, auth
      headers, enabled, app scope), the snapshot table, and the
      per-assistant selection table. A `tool-connections` feature
      follows the feature contract: schemas, service, Route Handlers on
      the shared wrappers, traces for every mutation, registration in
      `lib/features.ts` with `featureDebugHref`. The client speaks
      Streamable HTTP with the legacy SSE fallback and configurable
      auth headers, with a connect timeout.
- [x] **B — discovery, snapshot, apply, drift** (`71bbb87`). Connecting lists tools
      and stores a snapshot; re-discovery diffs and reports
      added/changed/removed without touching what the model is offered;
      Apply is the only thing that moves the snapshot forward, and it
      bumps the connections revision. Discovery failures are recorded
      and surfaced (never console-only).
- [x] **C — scoped toolset resolution + prefixing** (`54ac7b1`). A turn's toolset is
      built-ins plus the snapshot tools of enabled connections matching
      its source and assistant, prefixed by slug; calls route to the
      owning connection, are traced like in-process tool calls, and a
      dead endpoint or unknown tool comes back as a tool error. The
      delivery-tool carve-out (`reply` vs `send`) keeps working across
      the rename.
Slice notes:

- **A (`21d5a2b`)** — core migration 0004: `tool_connections`
  (slug/name/transport/endpoint/auth headers/enabled/app scope/
  all-assistants/managed + discovery outcome), `tool_connection_tools`
  (the applied snapshot), `assistant_tool_connections` (the explicit
  selection). Feature `tool-connections` follows the contract —
  zod schemas, repository, service with traces and `publishEvent`,
  thin Route Handlers, registry entry with the new `tools` realtime
  topic. `server/mcp/http-client.ts` speaks Streamable HTTP with the
  legacy SSE fallback on a failed CONNECT only (never on a failed call —
  that would replay work), short-lived sessions, 20s timeout. Header
  values never leave the server: not to a client, not into a trace body.
  Proof: 8 unit + 6 integration cases green, migration applied to the
  dev store, typecheck across 11 workspaces, lint clean.
- **B (`71bbb87`)** — migration 0005 adds `last_discovered_tools`:
  discovery stores what it SAW beside what is applied, and the drift is
  computed on read (two columns compared, so no stored summary can
  disagree with either). Apply writes the reviewed discovery rather than
  a fresh fetch, so the operator confirms what was on screen. Canonical
  JSON compare means a reordered schema is not drift. A failed discovery
  records its reason on the row and settles a failed trace while the
  applied toolset keeps working. Proof: 5 integration cases against a
  REAL MCP server over Streamable HTTP (`test/fake-mcp-server.ts`) —
  the wire parts are the ones worth doubting, and one of them (auth
  headers actually arriving) is asserted directly.
- **C (`54ac7b1`)** — `resolveConnectionToolset` is the one scope
  resolver: enabled + app scope + assistant selection, no per-source
  branch anywhere. Connection tools are offered as `<slug>__<tool>`;
  built-ins keep bare names. The turn binding travels as MCP `_meta`
  (`packages/contracts/src/tool-meta.ts`, namespaced `assistant-hub/turn`)
  — a hosted tool receives the chat, never a model-chosen argument for
  it. `getToolset` composes both halves and dispatches by owner; the
  reply path states its scope explicitly, the fire path resolves per
  fire inside the tool context it already binds (so a fire's toolset is
  its task's assistant's). A dead endpoint or unknown name is a tool
  error, never a failed turn. Proof: 6 integration cases (scoping,
  prefixing, `_meta` arrival, error paths), core unit 1190 green,
  typecheck + lint clean.
- **D-1 (`82a46ff`)** — `apps/tg` serves `/mcp` (shared
  `serveMcp` glue in `@assistant-hub/service`, behind the same
  internal-token guard as `/internal`), and `set_message_reaction`
  moved into it with the Telegram knowledge that came with it: the 73
  emoji, the presentation-selector normalization, the mirror gate. The
  core auto-provisions one managed, app-scoped connection per configured
  source at boot (`managed.ts`) — **the one exception to
  discover-then-apply**, argued in the file: these tools ship with the
  release, so their snapshot follows the code, and a source that has not
  finished starting keeps the tools it last offered. Deleted with the
  tool: the port's `setReaction`, the tool context's reaction binding,
  both apps' REST reaction endpoints and the contract schemas. Chat now
  offers no reaction tool at all rather than one that answers
  `unsupported` (a change from the Phase 4 decision, and a better answer
  to it — the model never sees an action it cannot take).
- **D-2 (`2161a88`)** — `reply_to_message` and `send_message` follow,
  into both source apps. The core keeps the bookkeeping that was never
  about Telegram (a task stamping its wording, a fire counting what
  reached the chat) and learns what happened from the tool RESULT — a
  `delivery` any source can report (`toolDeliveryResult` in contracts),
  not a hook keyed on a tool name. `McpToolContext.deliver` became
  `onDelivered`; `deliveryKind` and `replyToMessageId` travel in
  `_meta`, so the double boundary that kept a fire from claiming it
  replied now spans two processes. tg's REST send and its MCP tools share
  one `sendChatMessage` (link mirroring, the send, the mirror row,
  cross-feed).
  Proof for both: tg integration 72 green (12 in a new MCP suite driving
  a real client over the served transport — token guard, `_meta`,
  mirror gate, delivery kinds, refused sends), chat 27 green (6 new),
  core unit 1172 + integration 362 green, typecheck across 11 workspaces,
  lint clean. **Live on the operator's running services**: an untokened
  POST to `/mcp` is 401 on both apps, and a tokened `initialize`
  answers `assistant-hub-tg` / `assistant-hub-chat`.
- **E (`f0f6b9c`)** — `/tools` is two tabs: the catalog (feature tools
  and connection tools under their prefixes, each group stating where it
  is offered) and Connections (CRUD, Discover, Apply with the drift
  badge, health, app scope, per-assistant selection), live over the new
  `tools` realtime topic, times through `<Timestamp>`. Header values are
  write-only in the editor. **Verified live in the running dashboard**:
  a connection created through the form against a throwaway MCP server →
  Discover showed "2 new" while the page still said the assistants keep
  the applied set → Apply moved the catalog 16 → 18 tools with
  `probe__coin_flip` / `probe__echo` under "offered on tg turns, for
  every assistant" → Delete returned it to 16/0. All four actions landed
  as `tool-connections` traces (create / discover / apply / delete, all
  success) in Debug. One fix came out of that check: the cached drizzle
  store handle now notices a schema change, because a handle built before
  migration 0004 kept answering `db.query.toolConnections === undefined`
  after hot reload.

- [x] **D — source MCP servers** (`82a46ff`, `2161a88`). `apps/tg` and `apps/chat` each serve
      `/mcp` behind the internal-token guard, exposing their
      model-facing outbound tools over the outbound port they already
      implement; the core auto-provisions one managed, app-scoped
      connection per source app (not operator-deletable) and its
      hand-written `bot-messaging` / tasks-outbound registrars are
      deleted. `set_message_reaction` still answers `unsupported` on
      chat rather than throwing.
- [x] **E — tools dashboard rework** (`f0f6b9c`). `/tools` gains the shared Tabs:
      the offered toolset (grouped by owner, showing scope) and
      Connections (CRUD, discovery/apply with the drift summary, health,
      per-assistant selection). Live over the shared SSE layer, times
      through `<Timestamp>`, and a downloadable JSON bundle.

## Phase 4 — Web chat (acceptance criteria)

Scope from PLAN.md: `apps/chat` as the second source app plus its
`apps/chat/ui` extensions — threads UI (create/name/pick assistant),
text + image upload + voice, live turn progress, message-at-once
delivery, memory/trace parity with telegram chats.

Decisions (user, 2026-08-27, all four as recommended):

1. **Backend shape — the standing recommendation is confirmed.**
   `apps/chat` is a plain Node/Hono service, tg's twin (operator API +
   internal API + inbound producer + delivery/lifecycle consumers); its
   dashboard UI ships as `apps/chat/ui` and renders inside the core Next
   build. No second Next app, no second origin.
2. **Content-plane parity is scoped to memory, traces, vision and
   voice.** The summarizer, the hybrid search index and the analytics
   dashboard stay telegram-only; whether web threads join them is a
   later phase's call. Chat therefore serves the operator listing
   contract and the media/internal API, not tg's `content/*` surface.
3. **Voice both directions.** Uploads are transcribed by the core voice
   pipeline and answered voice-to-voice when a speech endpoint is
   configured — the turn consumer's voice path is already
   source-generic, chat implements `sendVoice`.
4. **Full outbound port.** Chat implements
   `sendMessage`/`sendVoice`/`sendPhotos`/`sendFile`/`deleteMessage`, so
   image generation, browser-agent downloads and timed task fires reach
   a web thread. `setReaction` has no web analogue: it answers
   `unsupported` so the tool reports it, rather than throwing.

Design notes settled in-session (no user call needed — they follow from
the decisions above and existing code):

- **The core's source couplings become a registry, not a second copy.**
  `resolveSourceOutbound()` and `tgApiMediaStore` are tg-hardcoded
  (`TG_API_URL` from env); Phase 4 turns them into a per-source lookup
  keyed by `event.source`, the way `DIRECTORY_SOURCES` already is. A
  feature that grows a second `if (source === "tg")` branch instead is
  a failed criterion.
- **Dashboard mount stays app-agnostic.** The shell gains ONE generic
  route (`/apps/[app]/[[...rest]]`) that renders the registered app's
  contributed page; nav items come from the app's `AppExtensions`. The
  shell never names "chat" — the rule from PLAN's dashboard-composition
  section.
- **Memory keying becomes source-aware.** `identitiesOf` hardcodes
  `scopedRef("tg","user",id)` and labels come from the v1 `known_users`
  table, so a chat user would read as `User <uuid>` and link to
  nothing. Memory rows stay v1-keyed until Phase 6 (Phase 3 decision),
  but the read path takes the caller's scoped ref and the label the
  source already supplies on the inbound event.

Slices:

- [x] **A — chat service + operator API + registry entry** (`ac08dc9`).
      `apps/chat` is a running Hono service (`src/db|store|api|index`)
      serving the operator listing contract for its users, threads and
      messages: a thread is a `direct` chat whose roster is its owner,
      and the curated fields are writable — store migration 0001 added
      them (user aliases/language, thread notes/language) plus the
      message reply target and soft delete the outbound port will need.
      The core registers chat in `DIRECTORY_SOURCES` (one line), proxies
      `/api/chat/threads`, and mounts the app's page generically:
      `/apps/[app]/[[...rest]]` renders whichever app owns the segment,
      so no shell route names "chat". `apps/chat/ui`
      (`@assistant-hub/chat-ui`) contributes the nav entry and the
      threads page.
      **Extracted rather than copied a second time** (the second copy is
      exactly what this slice would otherwise have written):
      `@assistant-hub/service` — bootstrap env, the internal-token guard
      and the source-parameterized bus helpers (trace client, dashboard
      refresh); tg moved onto it and its three thin wrappers are gone.
      Core-side, `server/source/internal-client.ts` resolves one
      requester per source **from its id** (`TG_API_URL`/`CHAT_API_URL`
      — a lookup, not a branch) and `operator-client.ts` holds the
      source-neutral half of the operator client, leaving tg with only
      its connections and owner settings. Page chrome
      (`PageHeader`/`EmptyState`/`Card`) and the timestamp rule
      (`<Timestamp>`, `TimezoneProvider`, the formatters) moved into
      `@assistant-hub/ui` so an app-contributed page renders instants in
      the operator's timezone and looks like the shell's own; core keeps
      every import path via re-exports. Deployment came along: chat's
      Dockerfile, its compose service, `CHAT_API_URL` on the core, the
      release matrix entry, and the initdb hook generalized to create
      every source app's database.
      Proof: chat operator-API integration suite (7 cases, real
      Postgres) green; tg integration 61 green after the refactor; core
      unit 1175 green; typecheck across all 10 workspaces; lint clean
      (only pre-existing warnings). The service was booted against the
      dev store — `/health` probes the database, `/internal/chats`
      answers, an untokened call is 401 — and `/apps/chat` was read in
      the running dashboard, where an unconfigured `CHAT_API_URL` says
      so in words instead of showing an empty list. Dev topology now
      exists (database `chat` created + migrated, `apps/chat/.env`
      written, `CHAT_API_URL` added to `apps/core/.env`); the dev server
      has not been restarted, so the core still runs without that
      variable — **the green listing path is verified after the next
      restart** (`npm run dev -w @assistant-hub/chat` alongside the
      other two processes).
- [x] **B — threads and the text turn end to end** (`f81e2b8`). Thread
      CRUD (create with a name + an assistant fixed at creation, rename,
      delete), the operator's own chat user created on first contact,
      and the two-pane chat page (`apps/chat/ui`) that starts threads,
      reads them and sends into them — deep-linked at
      `/apps/chat/<threadId>`, live on the `threads` topic, message at
      once. The turn itself: `postThreadMessage` stores what the human
      said, composes the context from this app's store and enqueues ONE
      inbound event; the core's pipeline runs unchanged; the delivery
      consumer stores the reply and pings the dashboard.
      **What a web thread lacks turned out to be the design work.** It
      has no bot account → `connection` is now optional on the inbound
      event, and the assistant's own name is the only name there is. It
      has nobody else in the room → addressing is settled at the source
      (`private`) and the analyzer never runs. It is not Telegram → the
      outbound port resolves by source id (`sourceOutbound(source)`,
      `server/turn/source-outbound.ts`), so the sends are written once;
      the three callers that still carry raw telegram ids (the reaction
      tool's task-fire path, browser runs, task fires) each say so in
      one comment — no branch — and get refs when their stores are
      generalized (slice F).
      **The live check caught a lie the second source made visible**:
      the base system prompt asserted "a Telegram chat", so the first
      web thread twice placed itself in Telegram. Fixed where it
      belongs — the prompt now names no platform, and the chat-context
      block carries a per-turn surface line derived from
      `event.source` (`surfaceLine` in `server/turn/render.ts`), with
      the direct/group context blocks stripped of their own "Telegram".
      Also: `chat` is a trace trigger kind, so Debug can filter
      web-thread turns from dashboard button presses (the filter's
      options come from the schema, so nothing else changed).
      Proof: 14 chat integration cases (real Postgres + Redis: the
      queue round-trip, the bus round-trip, the window's exclusions, a
      reply for a deleted thread, retraction), core 1175 unit + 338
      integration green, typecheck across 10 workspaces, lint clean.
      **Live in dev**: thread created, message sent, reply rendered in
      ~5s over SSE without a reload; the surface fix re-verified after
      a restart ("a web chat, using a browser to talk to me"). Dev note:
      the turn consumer is a boot-time module — a prompt edit is not
      live until the dev server restarts, which is exactly how the wrong
      answer was diagnosed (the trace showed the old system prompt).
- [x] **C — live turn progress** (`0cd86a4`). The core published a
      turn's lifecycle already; what was missing was the tool's NAME —
      the actions-started hook wrapped every tool call and threw it
      away. It now travels with the hook, so the same `progress` event
      serves both sources: tg ignores the label and keeps typing, the
      chat app keeps the running turn per thread (`src/turns.ts`) and
      serves it with the transcript, so the view shows "Thinking…" from
      `accepted`, "Working — <tool>…" during a tool, and nothing after
      `settled`. The dashboard is pinged only when what a reader would
      see actually changed. Still message-at-once — no token streaming
      (PLAN). The state is in memory and expires on its own: a turn the
      core never settles must stop claiming to run rather than leave a
      thread thinking forever, and after a restart the transcript is
      the record. Proof: 5 unit cases on the state machine, one
      integration case driving accepted → progress → settled over the
      real bus and reading it back through the API, tg's 61 integration
      cases green with progress events now arriving. Live: "Thinking…"
      appeared and cleared in the dashboard; the tool-label window was
      under a second on this model (the trace shows the `history_search`
      call it belonged to), so the label itself is proven by the bus
      test rather than by a screenshot.
- [x] **D — images** (`97a6c62`). An upload in a thread is normalized
      (`@assistant-hub/media`), stored `pending`, and referenced on the
      inbound event exactly as a Telegram photo is, so the core's vision
      pipeline describes it through the per-source media port
      (`sourceMediaStore(source)` — the same lookup shape as the
      outbound port) and writes the text back. The backfill sweeps every
      configured source in turn and reports per source; the gallery
      merges them and tags each card with the app that holds it.
      **Deliberate divergence, recorded in the code**: Telegram is its
      own archive so a described photo drops its bytes; a web thread is
      the only archive its pictures have, so the chat store KEEPS them.
      Listings ship bytes for pending rows only; the thread and the
      gallery fetch one picture by id (`/api/chat/media/<id>`,
      `MediaView.bytesUrl`) when they render it. The operator can
      reverse this by making chat's `markDescribed` drop blobs like
      tg's.
      Also extracted: `normalizeImageForChat` existed twice,
      byte-identical, in core and tg — it is now
      `@assistant-hub/media`, imported by all three apps.
      Proof: the media round trip in the chat integration suite (upload
      → pending → work list → bytes → write-back → still served
      afterwards), an unreadable upload that answers on the text instead
      of losing the message, core 1175 unit + 338 integration green.
      **Live in dev**: a red square uploaded through the proxy, described
      by the vision model ("a flat, even shade of red"), answered by the
      turn ("It's red."), rendered in the thread and in `/vision` under
      "Web chat".
- [x] **E — voice, and the rest of the outbound port** (`267fd80`). A
      voice note recorded in a thread (MediaRecorder → whatever container
      the browser gives) is stored raw and transcribed by the core — the
      same path a Telegram voice message takes, since the core converts
      to WAV before asking the model either way. A voice turn is answered
      with an audio bubble whose message CONTENT is the spoken text (what
      the window and the next turn read), born `described` so the
      backfill never goes listening to the assistant's own voice.
      The port is now complete: `sendPhotos` lands one message per
      generated image carrying the picture, `sendFile` keeps a produced
      file where the thread can offer it back, and `setReaction` answers
      a new `unsupported` status — a source saying the platform has no
      such affordance, so the tool tells the model the truth instead of
      the core inventing a refusal.
      **Two roots the second source exposed, fixed as roots**:
      `IncomingMessage.chatId`/`fromId` were numbers, so a thread's uuid
      reached every trace as the string `NaN` — they are source-local
      strings now; and the trace trigger said `telegram` for every turn
      (reply, tool, TTS), so the turn's `source` now travels to each of
      them and the Debug filter means something with two sources.
      Proof: 19 chat integration cases, a web-thread case in the core's
      turn-consumer suite pinning both the surface line and the trigger,
      1175 unit + 339 integration green. **Live in dev**: a recorded tone
      was stored, transcribed ("(no speech)" — correct for a sine wave)
      and answered ("That was a silent one."). The voice REPLY half is
      test-covered only: this dev environment has no speech endpoint
      configured, so TTS could not run.
- [x] **The chat page, reshaped** (`2d9cde6`, user request after the
      slices landed). The layout everyone already knows: chats down the
      left with "New chat" at the top, the conversation on the right,
      the composer at the bottom. The create-a-thread FORM is gone — a
      new chat is a blank conversation and the thread is created by the
      first message, so an abandoned one never piles up.
      **Conversations name themselves.** A source with no name for its
      conversations says so on the inbound event
      (`chat.titleProvisional`, chat store migration 0002) and the core
      names it once, after the first exchange, through that source's own
      `setChatTitle` — a classification call in
      `server/turn/name-conversation.ts`, best-effort by construction (a
      failure leaves the placeholder, which is a worse label, not a worse
      answer). Telegram never sets the flag: its conversations have real
      names. Two rules keep it honest — only a thread still wearing its
      placeholder can be auto-named, and renaming by hand clears the flag,
      because a name someone chose is not a placeholder. The header title
      is click-to-rename.
      Proof: 21 chat integration cases (nameless creation, the flag on
      the event, a late title that cannot overwrite a chosen name), a
      core case asserting the naming happens exactly once, all suites
      green. **Live**: a chat started from an empty composer answered and
      titled itself "Maintaining sourdough starter while traveling" in
      the sidebar without a reload; the next message ran no second
      naming call.
- [x] **F — memory, traces and person links** (`150b986`, plus the
      trigger work in `267fd80`). The blocker was not the reading —
      Phase 3 built that — but the WRITING: both memory tables keyed
      their person by a foreign key into the telegram directory, so a
      fact about a web user could not be stored at all. **v1 migration
      0060 drops that constraint** (reasoning in the SQL): the id is a
      source-local user id from whichever source wrote it, and person
      links tie a human's identities together. The read then became
      source-aware where it was still telegram's — identities resolve in
      the CALLER's source, and a linked identity from ANY source
      contributes its document, since the memory tables are one flat
      keyspace — and the turn hands over the labels the source already
      resolved, so a uuid never reaches the model as "User 0b1c…".
      Traces: chat-side actions record through the shared client into
      the one store on the turn's correlation (slice B), and every
      trigger now carries the turn's source (slice E), so `/debug`
      filters web-thread turns as `chat` with a real actor id — checked
      live in the explorer.
      Proof: a new integration case walks the pair the design exists for
      (telegram → web thread and back, plus the memory tool from either
      side); memory suites 48 green; core 340 integration green.
      **Known limits, recorded rather than papered over**: the
      memory-extraction job still reads telegram content only (the
      content-plane parity this phase deliberately excluded — decision
      2), and naming a THIRD person by name inside a web thread refuses
      because that resolver reads the v1 telegram directory (the "about
      me" case, which is the one a thread has, works). The operator's
      own live link check (link the web user to their telegram user and
      watch memory follow) is the one verification left.

## Phase 3 — Assistants (acceptance criteria)

Scope from PLAN.md: assistants CRUD + personality conversion,
per-assistant telegram connections with concurrent pollers, per-assistant
tasks, own-name addressing + bot-to-bot rules, aggregated users/chats
pages + person links. Decisions applied (user, 2026-08-24): the
assistant-scoped brain reads (persona by `event.assistantId`,
per-assistant tasks) flip to the v2 core store in THIS phase, while
memory/settings/self-improvement stay on v1 until Phase 6; the
bot-to-bot loop guard defaults to N=3; the MCP-outbound shape is
confirmed as tg's REST send API + core-side tool bindings (flag closed);
the dev core store is populated (core import run 2026-08-24, one
assistant converted from the active personality, all counts reconciled).

- [x] Assistants CRUD (`d8bb88a`): feature-contract service over the
      v2 store's `assistants` table (create/rename/edit persona/delete;
      name unique case-insensitively, 32-cap), Route Handlers on shared
      wrappers, dashboard page + nav entry, traces for every mutation,
      live updates ("assistants" topic), `/debug` scoping. Deleting an
      assistant publishes `assistant.deleted` (new contract event); tg
      reacts by dropping the assistant's connections and stopping their
      pollers. New shared plumbing: `server/store/db` (the v2-store
      drizzle handle over the turn-markers pool) and `server/bus/
      publisher` (env-gated; a delete with no bus records a loud trace
      warning). The personalities page is retired in slice B with the
      reader flip. Tests: 5 store-backed service cases + a tg runtime
      case for the deletion reaction.
- [x] Persona flip (`14d2932`): the turn consumer resolves the persona
      from the v2 `assistants` row named by `event.assistantId` (an
      unknown id composes no persona and logs loudly); assistant-less
      flows (task fires, reflection context) ride a transitional
      single-assistant helper until the tasks flip stamps one per task;
      the personalities feature is fully retired (service/routes/page/
      registry/tests deleted — the frozen v1 table and settings column
      wait for Phase 6). Affected suites green (turn consumer,
      self-improvement, task scheduler; full core integration 322).
- [x] Tasks flip (`1323326`): the tasks feature moved to the v2
      store's per-assistant `tasks` table — `assistant_id` FK with
      cascade, scoped refs translated at the repository boundary,
      `created_by_owner` added by store migration 0002. Chat turns act
      on the event's assistant (bound onto the tool context; a turn
      with no assistant bound is refused, never guessed), the prompt
      cap and duplicate guard scope per assistant, timed fires run as
      their task's assistant (persona per task, `?assistantId=` on the
      send — the tg API already took it), and the dashboard create
      dialog picks the assistant (hidden while only one exists).
      Directory rosters and the timezone stay v1 shadow reads through
      the app pool until Phase 6. The tasks + scheduler integration
      suites now run the live two-database topology. Dev store's tasks
      table was empty at import (no live v1 tasks), so no data moved.
- [x] Per-assistant connections (`e78cede`): the assistant
      editor mounts source-app sections through the extension registry's
      new `assistantSections` point — `apps/tg/ui`
      (`@assistant-hub/tg-ui`, the first real registry consumer)
      contributes the Telegram connection section (connect/retoken/
      start/stop/disconnect over the operator connections API, live on
      `status` events via a shell-supplied `refreshSignal`). The shared
      form primitives (cn/Slot/Label/Button/Input/Field/Badge) moved to
      `@assistant-hub/ui` (its documented purpose; core re-exports keep
      every import path), with `@source` directives so core's Tailwind
      scans both packages. Core serves thin `/api/telegram/connections`
      proxy routes; the operator client now relays the source's
      verdicts as typed ApiErrors (409 one-bot-per-assistant included).
      The single-bot surfaces retired with the flip: Settings' bot-token
      field is gone (the tab points at Assistants), the Overview control
      lists every connection with per-row start/stop, and the sidebar
      card summarizes across connections (`summarizeConnections`,
      unit-tested; errors win, then running, then stopped).
      `assistant.deleted` → poller stopped + row dropped was proven in
      slice A (runtime suite). Concurrent pollers are proven at the API
      seam (two assistants' connections listed/reconciled independently,
      each with its own poller state) — the **two-live-bots check is
      operator-run** (needs a second real bot token) and gets recorded
      here when done.
- [x] Per-assistant DM streams (`b34c247`, user decisions 2026-08-24
      after the two-bot live test): a DM's chat id is the PEER's user id —
      identical for every bot that talks to them — and Telegram numbers DM
      messages per (bot, peer) pair, so the shared mirror merged two
      assistants' DM histories and could silently drop colliding message
      ids as "already mirrored". The mirror gains `assistant_id` (tg store
      migration 0002; the old pair-unique index became two partial ones —
      groups keep the shared chat-wide stream, DMs are unique per
      assistant; the composite FKs from media/message_search had to drop
      with it — mirror rows never hard-delete, so the cascades were
      theoretical). Turn-critical paths are conversation-scoped (inbound
      mirror + dedupe + reply-target check, context window, delivery
      mirror + settle release via a new optional `assistantId` on
      `turn.lifecycle`, feedback own-reply gate, `#id` whitelists, send
      API mirrors/delete/reaction via `?assistantId`); the v1 import
      stamps all DM rows with the derived assistant; the dev store was
      backfilled (63 historical DM rows → the original assistant, the
      test rows → the new one). Also per user decision: the persona block
      now leads with a structural identity line ("You are <name>.") so a
      third-person persona still knows its own name — shared
      `personaBlock` behind `getAssistantPersona` /
      `getSingleAssistantPersona`, used by the turn consumer and timed
      fires alike.
      **Deliberate follow-up (content plane, not assistant-aware yet)**:
      operator/history listings, summaries, search index (PK is still the
      chat+mid pair — DM collisions overwrite), analytics and media
      lookups read DM chats unscoped, mixing both streams; scoping them
      needs URL-level controls and job redesign — slice F / Phase 6
      territory, recorded here so it is not mistaken for done.
- [x] Shared-chat behavior: ~~each assistant's deterministic addressing
      checks its own name only~~ — landed early (`eeb3724`, user
      decision 2026-08-24): the spoken-summons identity is the
      ASSISTANT's name, and the name check moved CORE-side (the name
      lives in the core store and renames take effect instantly; tg
      keeps only the structural verdicts — reply/@mention//command/DM —
      and hands undecided group text over as `needsAnalyzer`; the core
      runs the same v1 name regex against the event assistant's name,
      then the LLM analyzer, whose prompt and the filed addressing
      exclusions now also carry the assistant name). The bot account's
      profile name never drives addressing or the prompt. Remaining
      for this criterion: the tg app cross-feeds one assistant's
      delivered reply as an inbound event to OTHER enabled assistants
      present in the same chat (Telegram never delivers bot messages to
      bots), gated by the loop guard: after N consecutive
      assistant-authored turns in a chat with no human message,
      assistants stay silent there until a human speaks. N lives in the
      v2 core settings row, operator-editable, default 3; the guard is
      deterministic (no LLM).
      **Cross-feed + loop guard landed (2026-08-26).** tg side: an
      assistant message that lands in a GROUP becomes an inbound event
      for the other assistants present there
      (`apps/tg/src/cross-feed.ts`). Presence is a new store table
      (`chat_assistants`, migration 0003) stamped by each poller from
      what Telegram actually delivered to its bot — a bot that is not in
      the chat could not answer there anyway. The five outbound paths
      that mirrored an assistant row by hand (the delivery consumer plus
      the four internal send endpoints) now go through ONE seam,
      `recordAssistantMessage`, so no delivery can grow a mirror row
      without the chat's other assistants hearing it; that seam declines
      to feed a `silent` send (a transient ack of background work), a
      message with no text (a generated image), and a DM. The fed event
      is an ordinary inbound event except for the new contract field
      `authoredByAssistantId`; its structural verdict is the entity-free
      half of the addressing check (reply to one of the receiver's own
      messages, or its literal `@username`), everything else undecided
      for the core's name check and analyzer. Its correlation carries the
      receiving assistant (`<chatId>:<messageId>:<assistantId>`) — one
      delivered message can open a turn per assistant present, and the
      turn-action markers and traces key on it; `startReplyTrace` and
      `IncomingMessage` grew a `correlationId` so the core stops deriving
      one that would merge them.
      Core side: the guard (`server/turn/loop-guard.ts`) counts the
      trailing run of assistant messages in the composed window plus the
      incoming one and, at the limit, ends the turn before any work —
      ignored with reason `loop_guard`, still settled (the source
      releases its hold), and recorded as a skipped reply trace so the
      silence is explicable. N is `settings.assistant_loop_guard_turns`
      in the v2 core store (migration 0003, default 3, bounds 0–10, 0 =
      never answer each other), edited on Settings → General; the
      settings service reads and writes that half through a second
      repository (`store-repository.ts`) exactly as the owner field
      routes to the tg app. Reads fall back to the default when
      `STORE_DATABASE_URL` is unset (a v1-only deployment must still
      render the page); the write does NOT fall back.
      Two correctness fixes the cross-feed forced: history rows now carry
      `assistantId`, so a transcript renders another assistant's lines
      under its NAME instead of as the reader's own "You" (they were
      indistinguishable before — a latent bug in any shared group), and a
      cross-fed message's speaker is the authoring assistant's name, not
      the bot account's. A cross-fed sender is a bot account, so it is
      kept out of the person-shaped paths: no memory, no sender
      preferences, no directory/roster shadow row.
      The v1 import now stamps group replies with the derived assistant
      and marks it present in every chat it has history in (v1 was
      single-bot, so both are facts, not guesses); the dev tg store was
      backfilled the same way (5 group replies, 1 presence row).
      Tests: cross-feed + refusal cases (tg runtime integration), the
      cross-fed structural verdict (tg unit), transcript attribution
      (core unit), the streak/limit table (core unit), a cross-fed turn
      answered in the other assistant's voice + silence at the limit +
      the operator's limit of 0 (core turn-consumer integration), the
      loop-guard setting's round trip into the store row (core settings
      integration, which now runs a second database on its container),
      and the import's stamping (tg import integration).
      **Live-test fix (2026-08-26), the half the cross-feed exposed.**
      The operator's two-bot group test showed one bot answering a
      message that named the OTHER, and the named bot silent. The
      traces settled it: for each message there was exactly ONE tg
      `inbound` trace, always the same assistant's — the other never
      got a turn at all, so its addressing check never ran (the
      analyzer was reading the messages correctly; it was only ever
      asked on behalf of one bot).
      Root cause, predating this slice: a group's mirror is ONE shared
      stream, Telegram delivers the message to every bot in the chat,
      and `processIncomingMessage` bailed with `already_mirrored` for
      whichever poller lost the insert race. Whose turn ran was
      therefore a race between pollers.
      Fixed by fanning out where the message is processed: the poller
      that wins the mirror enqueues one event per assistant LISTENING
      in the chat, each with its own connection identity, its own
      structural addressing verdict (`checkAddressed` against that
      bot's account) and its own turn correlation. That set is now one
      shared concept, `audience.ts` — the same "who is listening here"
      the cross-feed uses. Fanning out at the winner (rather than
      letting every poller enqueue its own) is also what keeps a photo
      from being downloaded and ingested once per bot in the chat.
      With it, the turn correlation became uniform:
      `<chatId>:<messageId>:<assistantId>` for every turn
      (`turnCorrelationId` in contracts), because a turn is one
      assistant acting on one message, not one message. That closes a
      second latent collision from slice D — a DM's chat id is the
      peer's user id and its message ids are numbered per bot, so two
      bots DM'd by the same person produced identical correlations, and
      the core's turn-action markers key on them (one turn's settle
      would clear the other's marker). The tg `inbound` trace sits on
      the receiving poller's own turn and its enqueue event names every
      turn the message opened.
      **Second live test (2026-08-26) — the slice works end to end.**
      One human message naming both assistants opened a turn for each
      (the fan-out), both answered by name, one assistant's reply was
      cross-fed to the other and answered, the other reply was cross-fed
      and correctly ignored ("display name absent"), and the fourth
      message hit the loop guard (streak 3, limit 3) and stopped the
      exchange. The cross-fed transcript line read
      `[#204] Igor [reply to #203]: …` — the other assistant's words
      under its own name.
      One question the traces could NOT answer: the operator saw the
      cross-fed reply arrive as a plain message rather than attached to
      the message it answered. The delivery asked Telegram for the reply
      target, but `allow_sending_without_reply` means Telegram drops a
      target it will not attach and delivers anyway — silently — and the
      mirror recorded the REQUESTED target, so nothing anywhere said
      what actually happened. Now `sendMessage` reads the attached
      target back off the sent message: the mirror records what is in
      the chat, and the deliver trace carries both
      `requestedReplyToMessageId` and `replyToMessageId`, warning when
      they differ. Whether Telegram refuses bot-to-bot reply targets is
      then a fact the next live turn reports rather than a guess.
      **Answered 2026-08-27: it does.** Both cross-fed replies in the
      live run asked to attach to the bot-authored message they
      answered and Telegram delivered them unattached
      (`replyToMessageId: null`, warned), while every human-authored
      target attached. No action — the reply still lands, and the
      mirror now records what is in the chat rather than what was
      asked for.
      **Addressing verdicts now carry their evidence (2026-08-26).**
      Reading the live traces the operator noticed an asymmetry: a turn
      the bot stayed OUT of shows the whole analyzer exchange (request,
      response, verifier, verdict), while a turn it answered shows a
      single `addressing check` line — and for the structural sources
      (@mention, reply, /command, DM) that line's `reason` was empty and
      its `matchedText` null. The decision was there; the grounds were
      not. The cause is real and not going away: a message the cheap
      checks address never reaches the analyzer, so there is no exchange
      to read back — which is exactly why the verdict itself has to say
      what it decided on. Every deterministic verdict now carries a
      sentence naming its evidence (both apps: tg's structural half and
      the core's name half, cross-fed verdicts included), and the name
      check records the matched word AS WRITTEN in the message
      (`matchBotName`), since the sender's spelling need not be the
      configured one. Unchanged on purpose: `matchedText` still only
      drives an exclusion for an `analyzer` verdict — excluding a word
      the deterministic check matched would silence the bot's own name,
      which `addressing-report.ts` already refuses.
      Remaining risks: with three or more assistants in one chat, a
      reply fans out to each of them at once, so a short burst can land
      before the streak reaches the limit — bounded (the guard closes
      the chat as soon as the tail is N assistant messages), never
      unbounded, but noisier than a two-bot exchange. Presence is
      evidence-based, so an assistant joins a chat's audience (for both
      the fan-out and the cross-feed) only after Telegram has delivered
      that chat's traffic to its bot at least once — a bot added since
      the last message registers on the next one, and a bot REMOVED
      from a group keeps its presence row until something clears it, so
      a turn can still be opened for a bot that can no longer post
      there (its send fails and the trace says so). And the operator control writes the v2 store while the rest
      of the settings row is still v1 — one Save touching two databases
      until the Phase 6 cutover collapses them.
- [x] Aggregated directory (`70785a3`, 2026-08-27): the users and
      groups pages stopped reading the transitional v1 shadow and now
      aggregate — one fan-out over a registry of source apps
      (`server/source/directory.ts`), each serving the shared operator
      listing contract, every row tagged with its origin and scoped ref;
      `apps/chat` joins in Phase 4 by adding one registry entry. A
      source that is unconfigured or unreachable is neither fatal nor
      dropped: it comes back under `unavailable` and the shared
      `SourceUnavailableNotice` names it above the table (a silently
      short list reads as "nobody has messaged the bot").
      Curated edits follow the same seam: `writeSourceUser` /
      `writeSourceChat` moved out of the tg client into the registry and
      take a **scoped ref**, so the ref decides which source owns the
      edit — the dashboard PATCHes `/api/users/<ref>` and
      `/api/groups/<ref>`, and the group detail route became
      `/groups/[ref]`. The shadow write still follows, keyed by the
      ref's source-local id, telegram-shaped until Phase 6 — now said in
      one place instead of assumed everywhere.
      The contract grew what the pages need: `memberCount` on the chat
      listing, `GET /internal/chats/:id`, and
      `GET /internal/chats/:id/members` (roster + membership times), so
      the detail page shows the participants the source injects into
      that chat's turns rather than the shadow's copy.
      `getGroupWithMembers` and its types went with their last caller.
- [x] Person links (`ee9abd1`, 2026-08-27): CRUD over the v2 store's
      `person_links` / `person_link_members` (untouched since Phase 1),
      as a second tab of the Users page — the same people seen as humans
      rather than accounts. Two rules carry the meaning and are enforced
      where they can be explained: an identity belongs to at most one
      link (the picker disables a claimed one; the service answers a
      conflict naming it rather than letting the unique index throw), and
      a link needs at least two identities (breaking a person apart is a
      delete).
      Memory reads resolve through links (`resolveLinkedRefs`): both the
      injected context and `memory_recall` collect every linked
      identity's document, and two linked identities in one group become
      one block named by the identity actually present. **Reads only** —
      a fact is still stored under the identity that was named and
      consolidation still merges per identity. Resolution is
      best-effort: without `STORE_DATABASE_URL` (optional until the
      Phase 6 cutover) or with the store unreadable, every identity
      resolves to itself and memory behaves as it did before links
      existed; writes are not forgiving that way. Memory is still keyed
      by telegram ids until Phase 6, so a link member from another
      source has no document to contribute and is dropped at the one
      filter that goes away when memory moves to scoped refs.
- [x] Tests at each seam; lint/typecheck/test/build green from the
      root. Green as of slice F (2026-08-27, all from the root):
      `turbo run typecheck` 8/8 workspaces; `turbo run lint` clean (the
      same 7 pre-existing unused-import warnings, none in changed
      files); `turbo run test` core 1170 passed / 26 skipped, tg 31,
      contracts 15; `turbo run test:integration` core 338 passed / 30
      skipped, tg 61 passed; `turbo run build` green. New tests: the
      aggregation itself with sources injected (fan-out, refs, ordering,
      an unreachable source, an unconfigured one — multi-source behavior
      covered before the second source exists), the three new tg
      endpoints against real Postgres, the person-links schema bounds,
      person-links CRUD + conflict + resolution against the real store,
      and memory-through-links across both databases on one container.
      Verified live on the dev topology: both directory pages render
      from the tg store, the roster reads through the API, a notes edit
      by ref round-tripped into the source (set, then cleared), and a
      link was created from the directory, rendered with resolved
      labels, and unlinked again.
      **Deliberate follow-ups, not done here.** The pickers and reports
      that need core-local joins still read the v1 shadow: the tasks
      page's per-group people picker, the analytics page's user/group
      lists, and the Settings owner picker. The DM content-plane scoping
      recorded under slice D (operator/history listings, summaries,
      search index, analytics and media lookups reading DM chats
      unscoped) is untouched and moves to Phase 6 with the rest of the
      content plane.

**Boundary study (2026-08-24).** v1-personality readers to flip:
`server/turn/consume.ts` (the reply turn — flips to the v2 assistant
named by `event.assistantId`), `features/tasks/server/scheduler.ts`
(timed fires — flips with the tasks flip, persona from the task's
assistant), `features/self-improvement/server/reflect.ts` + scheduler
(reflection context — reads the feedback reply's assistant post-flip;
single-assistant deployments unchanged), and a DEAD read in
`features/browser-agent/server/runner.ts` (`void personalityPrompt`) to
drop. v1-tasks surface to flip: `features/tasks/server/repository.ts`
(343 lines on the v1 table) plus service/matcher/fire/scheduler/
mcp-tools/UI — the v2 store's `tasks` differs by `assistant_id` (FK,
cascade), scoped refs (`chat_ref`, `created_by_user_ref`,
`target_user_refs`) and **lacks `created_by_owner`** (predates the
authority rework — store migration needed). Store access generalizes
the `server/turn/actions.ts` pool pattern into a shared v2-store db
module. `assistant.deleted` does not exist in contracts yet; tg's
consumer reacts by stopping the poller and dropping the connection.
Slicing: (A) assistants feature + `assistant.deleted`; (B) persona
flip + personalities feature retired; (C) tasks flip; (D) connections
UI extension + concurrent pollers; (E) cross-feed + loop guard; (F)
aggregated directory + person links.

## Phase 2 — Source split (acceptance criteria)

Scope from PLAN.md: the Telegram runtime moves out of the core into
`apps/tg` behind the source contract (inbound events with context,
reply-delivery events, listing API, tg MCP server); Redis bus + queue; the
pipeline consumes the queue; dashboard controls go through tg's operator
API + bus. Decisions applied: BullMQ `attempts: 1` with the turn runner
deciding re-enqueue via the actions-started marker; conversation-derived
content is written/read through the owning app's API; the source resolves
and stamps `senderIsOwner` on inbound events.

- [x] Boundary study (2026-08-22). The seam already exists:
      `handleIncomingMessage` takes injected `BotMessagingDeps`, which
      split cleanly into **source-supplied** (loadHistory 24h window,
      loadChatContext participants/roster, loadCurrentTurn transcript
      line + reply target incl. quote, loadVision media notes,
      sendReply/sendVoiceReply, recordReply mirror write, startTyping →
      lifecycle events, policy owner/maintenance) and **core-owned**
      (generateReply, analyzers, loadMemory, loadSenderPreferences,
      exclusions, persona/self-correction/tasks blocks, time/language
      context, trace). The telegram runtime to move is
      `apps/core/server/telegram/*` (~1.6k lines: process-update,
      bot-manager, transport, process-reaction/callback) plus media
      ingestion. Outside consumers of that dir — the full list of seams
      to re-route: instrumentation.ts (boot), app/api/telegram/bot
      (dashboard control → tg operator API), dashboard layout/page (bot
      status), bot-messaging mcp-tools (outbound sends → tg MCP server),
      image-gen deliver + browser-agent runner + tasks scheduler
      (deliveries → reply-delivery events / tg MCP tools),
      server/mcp/context, test/simulate. Note: reactions/callbacks
      (feedback flow) become tg-local now that feedbacks live in the tg
      store, with a bus event feeding core's reflection/folding jobs —
      its event shape gets designed during extraction, not up front.
- [x] `packages/contracts`: the source-app contract — inbound message
      event (scoped refs, resolved `senderIsOwner`, conversation context:
      history window + participants + chat metadata), reply-delivery
      event, turn-lifecycle events (accepted / progress / settled), bus
      event envelope, queue names/payloads; the listing/CRUD API shapes
      the dashboard aggregates. Grown across the slices with the
      internal send/media API shapes, `feedback.recorded`,
      `dashboard.refresh`, and the content API (messages window/ids,
      import, day-counts, summaries, search, index).
- [x] Redis infrastructure: compose service (dev + prod), `packages/bus`
      (BullMQ queue helpers with `attempts: 1`; pub/sub with typed
      envelopes); integration-tested against a real Redis.
- [ ] `apps/tg` runtime: poller(s) from tg-store connections, inbound
      persistence (mirror, media ingestion) in its own store, normalized
      inbound events with context onto the queue, reply-delivery
      consumption → send, lifecycle events → typing indicator, owner
      resolution from its settings, MCP server for outbound actions,
      operator listing/CRUD API for its entities.
      **Slice A landed (2026-08-23, `c41e6b7`)**: the service runs —
      poller lifecycle ported (tokens from connections), text-turn
      inbound processing (mirror + hold, owner resolution, composed
      context, one validated event per message, idempotent), delivery +
      lifecycle consumers (send → mirror; typing accepted→settled;
      settle releases the hold), Hono `/health` + `/internal/*` with the
      shared token, graceful shutdown; 5 integration tests green against
      real Postgres + Redis. Contract grew what the port surfaced:
      connection identity (bot username/display name), reply-target
      `stored`/`fromAssistant`, lifecycle `threadId`.
      **Also landed (67710d7)**: deterministic addressing is source-side
      — ported verbatim to apps/tg (unit-tested) and carried on the
      event (`addressing`); the core keeps only the LLM analyzer.
      **Remaining slices**: (B) media/voice ingestion + internal media
      API; (C) core queue consumer wiring `handleIncomingMessage` from
      the event (additive, v1-backed services); (D) feedback flows +
      MCP outbound tools + operator API; then the swap.
      **Slice D landed (2026-08-23, three commits)** — see the slice D
      notes below the slice C notes.
      **Slice C landed (2026-08-23)**: the core consumes the queue. The
      service seam (`IncomingMessage.message?`/`addressing?`, nullable
      delivered id), the shared `turn-bindings.ts` (generateReply +
      applyStandingTasks + classifier, extracted from process-update —
      one implementation for both paths), `server/turn/` (render:
      byte-identical v1 transcript/roster/current-turn from the event;
      actions: `turn_actions` markers in the v2 core store, migration
      0001; consume: deps-from-event, lifecycle publishing, per-chat
      ordering chain, retry policy), env-gated boot from register-node
      (REDIS_URL + STORE_DATABASE_URL). 6 integration tests prove:
      composed prompt parity, accepted→delivery→settled ordering,
      unaddressed turns settle without typing, generation failures
      deliver the v1 error notice (an action → handled, never retried),
      pre-action infrastructure failures re-enqueue without settling,
      acted/out-of-tries failures settle + rethrow. A live end-to-end
      topology smoke (tg poller → queue → core → bus → tg send with a
      real bot) is deliberately left for the swap slice — it needs the
      operator's environment.
      **Slice B landed (2026-08-23)**: media + voice cross the split.
      tg ingests every media message (detect/normalize/frames/download
      ported from the v1 vision feature — sharp in-process, ffmpeg
      sampling with thumbnail fallback, voice bytes raw), mirrors
      caption-less media as real turns, and serves the internal media
      API (`/internal/.../media`, `/internal/media/:id[/description]` —
      contract schemas in `@assistant-hub/contracts`, shared-token auth,
      describe-then-drop). Core-side: `describeAndStore` gained a
      `MediaStorePort` (default: the v1 DB — behavior unchanged; the
      consumer supplies the tg-API-backed port), and the consumer runs
      the v1 vision/voice flow from the event: in-turn recognize with
      caption/no-caption note composition, replied-to media resolution
      (no ingest-on-miss over the API — documented parity edge), eager
      voice transcription before addressing with the transcript-aware
      name check re-run core-side, one reply trace across
      transcription + reply. Env: TG_API_URL + INTERNAL_API_TOKEN on
      core. Tests: 4 tg media suites (real sharp normalization,
      unavailable markers, voice bytes, API round-trip incl.
      concurrent-winner) + 2 new consumer suites (photo recognize into
      the turn, voice answered from transcript via the re-run name
      check). Remaining for slice D: voice REPLY synthesis delivery
      (TTS bytes to tg), generated images, browser acks, `#id` links,
      feedback flows, MCP outbound tools, operator API.
      **Slice C implementation notes (worked out 2026-08-23)**:
      - `IncomingMessage` gets `message?` + `addressing?` — the consumer
        passes the event's verdict; the v1 path keeps calling
        `checkAddressed`. Only line ~524 of the service touches
        `incoming.message`.
      - The additive consumer uses v1 `getBotPolicy()` wholesale (v1
        settings still hold owner columns), so parity is exact;
        `event.sender.isOwner` becomes authoritative at the swap.
        **Swap blocker to design then (Phase 3 adjacent): task-authority
        rights** — v1 resolves "author is owner" against settings at
        match time; post-split the core must not hold owner identity, so
        tasks likely need `created_by_owner` stamped at creation.
      - Extract the `generateReply` + `applyStandingTasks` bindings from
        `process-update.ts` into a shared factory (mutable task state as
        a small state object) so the consumer and the v1 path share one
        implementation — no copy.
      - Actions-started marker: core-store `turn_actions` table
        (migration 0001), first live use of STORE_DATABASE_URL; mark
        BEFORE sendReply-publish and BEFORE each tool execution (wrap
        `callTool`); on terminal settle delete the row. Pre-action
        failure re-enqueues with attempt+1 (delay ~15s, cap 5).
      - Consumer gaps until slices B/D (documented, dev-only since the
        consumer only runs when tg feeds the queue): generated-image
        delivery, browser-run acks, linkable `#id` resolution (drops to
        plain text), vision/voice.
      - Core consumer starts from instrumentation only when REDIS_URL +
        STORE_DATABASE_URL are set.
      **Slice D landed (2026-08-23, `c0794fe` + `9aa4186` + `6b2725f`)**:
      - **D-1, outbound surface**: tg owns the transport boundary —
        `renderTelegramHtml` + `#id` link resolution against its own
        mirror (whitelist; invented ids stay text) + plain-text fallback
        — and serves the internal send API: text (silent-capable), voice
        (source-owned text fallback, reports `asVoice`), photos (mirror
        row + pending media keyed by the minted file id, real sharp
        normalization), delete (soft-deletes the mirror row), reaction
        (mirror-gated `not_found`/`own_message`, platform refusals as
        502 verbatim). Contract: reply-delivery gains `silent`, loses
        the never-consumed `preferVoice` (voice bytes cross the API,
        which can answer with the delivered id). Core consumer closes
        its slice-B/C gaps via `SourceOutboundPort`
        (`server/turn/tg-outbound.ts`, env-resolved like the media
        store): TTS synthesis stays core, audio crosses the API;
        generated images deliver after the reply; a browsing turn's
        reply goes over the API silent so its id registers as the run's
        self-deleting ack; `set_message_reaction` gets a per-turn
        `reactToMessage` port on the tool context (v1 branch unchanged,
        dies at the swap).
      - **D-2, feedback flows tg-local**: `message_reaction` +
        `callback_query` in allowed_updates; menu/options/codec ported
        verbatim; flows keep every v1 rule (menus only on the bot's own
        mirrored replies, single answerable reactor, "Other" →
        awaiting_text, free-text capture before the turn — mirrored,
        hold released, never enqueued). Completions publish the new
        `feedback.recorded` bus event (refs, reaction, text, topic;
        correlated to the reacted reply's turn). tg migration 0001:
        `feedbacks.model` nullable — this app cannot read reply traces;
        the core stamps it on write-back. No tg dev DB exists yet
        (.env.example only), so nothing local to migrate.
      - **D-3, operator API**: the shared listing/CRUD contract in
        `@assistant-hub/contracts` (`operator-api.ts`, source-neutral)
        served on `/internal`: users (labels + aliases/language PATCH),
        chats (mirror aggregates + group metadata, notes/language
        PATCH), a chat's full mirror with media annotations,
        connections CRUD (create/patch reconcile pollers via the new
        `BotManager.reconcileConnection`/`removeConnection`, delete
        stops+drops, token never returned — 4-char hint, one bot per
        assistant → 409), owner settings (changing the username resets
        the resolved id).
      - **Design call to confirm (user)**: PLAN's "source app exposes an
        MCP server for outbound actions" is implemented as the internal
        REST send API + core-side tool definitions bound per turn,
        because the tools' guardrails (delivery-kind refusals, task
        authority, actions-started marker, chat binding) are turn state
        only the core has, and the remote-MCP client machinery is
        Phase 5. The same handlers can be wrapped in an MCP endpoint on
        tg's Hono at Phase 5 if still wanted.
      - **Deferred to the swap slice**: core-side consumption of
        `feedback.recorded` (reflection scheduling, addressing-exclusion
        filing) + the folds/exchange reads and the model/reflection
        write-back endpoints on tg (`PATCH /internal/feedbacks/:id` does
        not exist yet); re-routing browser-agent runner / tasks
        scheduler / image-gen deliver onto `SourceOutboundPort` (the
        runner's ack deletion at settle still calls the v1
        `deleteChatMessage`); a `sendChatFile` equivalent endpoint for
        browser-run downloads; dashboard pages/proxy onto the operator
        API; the SSE bridge for tg-published events.
- [x] `apps/core`: telegram code removed; the pipeline consumes the
      queue; deterministic replies published as reply-delivery events;
      turn-lifecycle events published; the actions-started marker gates
      retry; core features that touch tg content (history tools,
      summarization, search indexing, vision describe) go through tg's
      API; dashboard telegram controls proxied to tg's operator API; the
      SSE layer bridges Redis pub/sub. Analytics rides the same API
      since `fe56e5f` (was the flip blocker — see Current state).
      **The swap (2026-08-23/24, commit by commit)**:
      - `7e52521` (W1): browser-agent runner, tasks scheduler and
        image-gen deliveries re-routed onto `SourceOutboundPort` (+ the
        new tg file-send endpoint with document-retry and caption
        fallback; run-ack deletion over the API); `test/simulate.ts` and
        `image-gen/deliver.ts` die.
      - `dbdc320` (W2): dashboard bot control/status/token through the
        tg operator API (`getSourceBotStatus`/`setSourceBotEnabled`/
        `saveSourceBotToken`/`saveSourceOwner`); settings owner writes
        route tg-first; `getTelegramBotToken` deleted.
      - `1a68b1a`: **the deletion** — `apps/core/server/telegram/*` and
        its tests are gone; boot is queue-consumer + events-consumer +
        schedulers only (loud warn when unconfigured); feedback learning
        re-seamed onto `feedback.recorded` (recorded-consumer →
        reflect/fold; exchange/analyze read feedbacks over the tg API;
        model/reflection write-back via `PATCH /internal/feedbacks/:id`;
        addressing exclusions file with `feedbackId: null` — the v1 FK
        cannot reference source rows).
      - `064d271`: the transitional **shadow directory** — the consumer
        mirrors event identity into v1 known_users/known_groups/
        group_members (FKs + labels keep working); curated edits
        (aliases/language/notes/owner) write tg-first, shadow second.
      - `5f4c0f5`: vision through the source — backfill, gallery and
        pending counts via `SourceMediaBrowse` (tg pending/recent media
        endpoints).
      - `3424deb`: the **content plane** — history service read-only
        over `SourceContentClient` (messages window/ids, transfer
        import, split due-scans comparing core job markers against
        source day/hour counts, summaries stored tg-side, hybrid RRF
        search + index ported to tg SQL); memory extraction re-seamed
        the same way; SQL-semantics tests moved to tg against real
        Postgres, core job tests over the contract-faithful in-memory
        `fake-source-content.ts`.
      - `5cdc242`: the SSE bridge (`dashboard.refresh` → in-process
        `publishEvent`, topics filtered against `REALTIME_TOPICS`; tg
        publishes on inbound, delivered replies, status flips, feedback
        menus).
      - `ec2b7ad`: the task-authority rework (owner stamps, above).
- [x] Trace client (`8428ea7`): apps record through the shared client
      over the bus (contracts `createSourceTraceRecorder` →
      `trace.recorded` → the core's events consumer ingests into the
      single store); correlation ids tie a turn's cross-app flow into
      one trace (tg inbound / feedback collection / delivery all stamp
      `<chatId>:<messageId>`).
- [x] Docker (`917131b`): `assistant-hub-tg` image (tsx-run Node service,
      ffmpeg, isolated drizzle migration runner on the tg chain) +
      compose service (own database via the initdb hook — first init
      only; existing deployments create it by hand) + release-matrix
      entry; core service wired with REDIS_URL / TG_API_URL /
      INTERNAL_API_TOKEN. Image build verified locally (tsx/ffmpeg/
      migrate runner resolve in-container); the full compose boot rides
      with the live end-to-end smoke (Current state).
- [ ] Tests at each seam; lint/typecheck/test/build green from the root;
      proof and risks recorded. Green as of the swap (core unit 1116 +
      integration 326/30-skipped; tg integration 43; turbo lint/
      typecheck/test/build) — stays open until the analytics re-route
      and trace client land their tests.

## Session log
- **2026-08-31 (Phase 8 closes: accounts)** — Six slices, six commits,
  and the single-operator era ends. The design calls settled at open
  (accounts join the person-link graph as their own web identity; the
  operator hash ports verbatim into the first admin; admin-created
  accounts get a temporary password with a forced change; web user =
  account) turned out to carry the whole phase: because an account's
  identity ref IS its web-chat ref, owner rights, memory, the link
  picker and the self-link flow all ride the existing person-link
  mechanism with no new contract. What moved where: sessions are
  per-account HMAC cookies carrying the account id (a password change
  rotates one account's secret); `defineRoute` gained access levels and
  hands bodies the acting account; the operator pages live in an
  `(admin)` route group whose one layout is the page-side role gate;
  `isOwner` left the transport contract — the ingest fan-out resolves
  it per receiving assistant from the sender's linked account against
  `assistants.owner_account_id` (admins everywhere), and the web chat
  runs the same resolver; the Settings owner picker, `saveSourceOwner`,
  tg's `OwnerConfig` and its writeback are deleted; `web_users` is
  dropped with a data-moving migration (threads, curated fields and
  every `chat:user:` ref land on the first admin); the profile page
  gives every role its own surface including the memory view + delete
  scoped strictly to the account's linked identities; and a
  code-shaped message is consumed by ingest before any turn opens.
  One reversal mid-slice: the self-link's extend-in-place branch
  originally let a second account attach to an already-linked person —
  the conflict guard now refuses it (merging people is an admin call).
  Migrations 0008–0011; the v1 import creates the first admin instead
  of copying credential columns.
- **2026-08-30 (Phase 7 closes: one store, stateless transports)** — Six
  slices in one session, and the design bet paid twice: the same
  per-source lookup seams that absorbed the chat dissolve absorbed the
  tg de-store, and `processInboundEvent` still has not changed. The big
  inversion is ingest: tg computes only what needs platform knowledge
  (structural addressing verdicts per running connection, the
  stream-shaped `dedupe_key`) and publishes transport updates with media
  bytes attached; a core ingest stage persists into the `source_*`
  tables, resolves the audience from presence ∩ running receivers,
  composes the context window from its own store, and enqueues the
  classic inbound event. Deliveries return as `message.delivered` events
  the core turns into mirror rows and cross-feeds; the `#id` link
  whitelist is resolved core-side and travels on the reply-delivery
  event. Registration replaces configuration: the `transports` row
  (base URL, MCP path, config field schemas) is written by tg's boot
  self-registration — which doubles as the desired-state fetch, retried
  until the core answers — and `transport.config.changed` /
  `assistant.deleted` bus events drive tg's serialized reconcile.
  The assistant editor renders every registered transport's section
  from its announced field schema, so a future transport gets its
  dashboard surface for free. What died: tg's database (compose,
  initdb, Dockerfile migration runner included), `apps/tg/ui`, the
  extension registry in `packages/ui`, `TG_API_URL`, `tg-content.ts`
  as an HTTP client, `tg-operator.ts`. Four integration suites needed
  their mocks re-pointed from deleted modules to the new seams —
  mechanical, no behavior changes. Live boot verified end to end:
  register → desired state → two pollers up.
- **2026-08-30 (Phase 6 closes: the chat app dissolves)** — Six slices,
  one session, and the pipeline never noticed: every seam the chat app
  plugged into was already a per-source lookup, so the merge swapped the
  chat resolution from an HTTP client to a local implementation and
  `consume.ts` kept publishing the same events — the core just became
  their consumer for its own source. What moved: the store (five `web_*`
  tables in the core store, migration 0006, dev rows ported), the
  inbound half (postChatMessage stores + enqueues in-process to the SAME
  queue — the "no queue hop" decision is about topology, not about
  forking the pipeline's ordering/retry/settle semantics), the delivery
  and lifecycle consumers (into the events consumer, with ThreadTurns as
  a globalThis-pinned singleton per the documented cross-bundle failure
  mode), the delivery tools (in-process under their old
  `chat_`-prefixed names, gated by a new generic offer predicate on the
  registry rather than a special case in the toolset service), the page
  (a plain `/chat` route; the extension registry keeps only tg), and
  the DTO schemas (out of contracts, into the feature). One rule the
  move surfaced: the page was never linted in its `ui`-package life and
  carried three `set-state-in-effect` violations — fixed by structure
  (effect-local loaders, a derived default instead of a
  synchronizing effect), not by disabling. The managed-connection
  reconcile now covers only transport sources, and the migration deletes
  the stale managed chat row.
- **2026-08-30 (target revised: one store, transports, accounts)** — The
  user changed the architecture before cutover, and the whole decision
  set was settled in one Q&A session; PLAN.md is rewritten in place and
  the old Phase 6 (cutover) became Phase 10 behind four new phases.
  The decisions, as answered by the user:
  - **Core+chat merge — full dissolve.** apps/chat disappears: store into
    the core schema, turns in-process (no queue hop), its MCP outbound
    tools become in-process core tools, its views become core pages.
  - **Stateless tg.** All conversation data (users, chats, messages,
    media) moves to core-owned generalized tables; tg forwards
    EVERYTHING (unaddressed chatter, edits, deletions, membership) and
    fetches media bytes itself, core stores them; the core composes
    context from its own store. Bot tokens live in the core DB as opaque
    per-transport config sections on assistants; tg holds no database.
  - **Zero-core-change transports.** The stated goal: "add Signal and
    connect it to core without any changes of core." Transports
    self-register at boot (id, name, config schema, MCP endpoint);
    dashboard sections are schema-driven forms (the build-time UI
    extension packages and registry are retired); no capability flags —
    typing is lifecycle rendering, media kinds are universally supported
    by core, platform actions are the transport's MCP tools (tg keeps
    the Phase 5 MCP server), and a transport degrades unsupported
    outbound kinds itself.
  - **Multi-user.** Username+password accounts, roles admin/user; first
    admin from /setup; admins create accounts, no open registration.
    Users get web chat + own data (own memory view+delete, profile,
    identity links) and create their own assistants with FULL parity
    (own bot tokens, tasks, tools); every assistant has an owning
    account and owner-rights = sender's linked account is the owner
    (admins everywhere) — replaces the global owner. Self-link via a
    one-time code sent to a bot. Users see their own assistants' full
    activity including telegram chats and those turns' traces. Users may
    register their own HTTP MCP connections (their own infra), public
    addresses only (private ranges blocked at connect and call time).
    Memory becomes global pool + per-person injected by chat membership.
    Offboarding: deactivate keeps data (reversible), hard delete
    cascades behind a confirm. No per-user quotas.
  - **Sequencing.** Rework first on the redesign branch, ONE cutover at
    the end; migration retargets to the single core store, the operator
    password becomes the first admin, and tg receives no data at all.
- **2026-08-28 (Phase 5 closes)** — Five slices, seven commits. The
  toolset moved out of the code: connections are rows, their tools are a
  snapshot an operator applies, and the source apps host the outbound
  tools whose whole content was a platform's affordances. Two design
  notes reversed themselves along the way and are recorded as reversals
  rather than tidied away: the registry-revision cache key (dropped in
  slice C for reading per turn, which cannot go stale) and chat's
  `unsupported` reaction answer (dropped in D-1 for simply not offering
  the tool). One bug the live check caught and the code now guards: a
  cached drizzle handle that survived hot reload kept answering
  `db.query.<newTable> === undefined` after a migration added a table.
  Left for the operator: a core restart (the managed connections are
  provisioned at boot) and one live turn.
- **2026-08-28 (Phase 5 opens)** — Acceptance criteria written and the
  three design calls answered by the user: scope dimensions global /
  per-app / per-assistant (per-chat and per-user dropped), snapshot-wins
  with reported drift and an explicit Apply, and source apps exposing
  real MCP servers instead of the core's hand-written outbound bindings
  — only the model-facing tools move, the bus and the REST send API keep
  their jobs. PLAN.md updated in place: the assistants section, the MCP
  tool-connections section, the Phase 5 bullet, and the out-of-scope list
  (per-assistant toolset selection is now in scope). Design notes fixed
  in the criteria: turn context travels in MCP `_meta` (verified against
  SDK 1.29.0, whose `RequestHandlerExtra` carries it) and never as a
  model-visible chat argument; built-ins keep bare names while connection
  tools are slug-prefixed; the registry's staleness identity gains a
  connections revision so an applied snapshot is not invisible until
  restart.
- **2026-08-27 (chat UI reshaped)** — The operator asked for the chat
  page to look like a chat app rather than a form: sidebar, "New chat" at
  the top, auto-generated titles. The layout was the easy half. The
  interesting half was where a title comes from: not the source (it has
  no LLM) and not a hardcoded branch in the core, but a flag on the
  contract — a source declares its name provisional and the core names
  the conversation through that source's own port. Telegram sets it
  never; a future source with unnamed conversations gets it free.

- **2026-08-27 (Phase 4 closed)** — Slice F, and with it the phase. The
  last thing standing between the assistant and a person it meets in two
  apps was a foreign key: memory keyed its subject into the telegram
  directory, so a web user could be READ about but never remembered.
  Dropping it (v1 migration 0060) was the whole fix, plus resolving
  identities in the caller's source and handing the model the names the
  source already knew. Six slices in one session; the phase's real
  product is not the chat page but everything it forced to stop assuming
  Telegram — the outbound port, the media port, the prompt's idea of
  where it is, the trace triggers, and the shape of an id.

- **2026-08-27 (Phase 4, slice E)** — Voice, and the last of the outbound
  port. The interesting part was again what the second source revealed:
  ids were typed as numbers in the message the pipeline consumes, so a
  uuid became "NaN" in traces, and the trace trigger was hardcoded to
  telegram everywhere — reply traces, tool traces, TTS traces. Both are
  now the turn's own source, which is the difference between a Debug
  filter that means something and one that lumps two apps together.
  Reactions got an honest answer for a platform that has none, rather
  than a refusal the core made up.

- **2026-08-27 (Phase 4, slice D)** — Images. The vision pipeline needed
  no changes; the media PORT did, and it got the same treatment as the
  outbound one — resolved by source id, with the backfill and the gallery
  fanning out instead of knowing about Telegram. The one real design call
  was whether a web thread drops its bytes after describing, as Telegram
  does. It does not: Telegram keeps the picture for you, a dashboard
  thread does not, and erasing what the operator just sent to save a
  hundred kilobytes is the wrong trade. Listings still ship bytes only
  for pending rows, so the gallery does not carry a hundred pictures.

- **2026-08-27 (Phase 4, slice C)** — Live progress, which turned out to
  be one missing argument: the hook that marks a turn as having acted
  already ran on every tool call and knew the tool's name. Passing it on
  gave both sources what they need from one event — Telegram keeps
  typing, the browser says what is happening. The chat side keeps that
  state in memory with an expiry, because a spinner that outlives its
  turn is worse than no spinner.

- **2026-08-27 (Phase 4, slice B)** — Web chat answers. The pipeline
  needed no changes to run a thread turn, which was the point; what
  needed changing was everything that had quietly assumed Telegram. The
  inbound contract now admits a source with no bot account, the outbound
  port is chosen by source id instead of being tg's, and the system
  prompt stopped claiming to be in Telegram — that last one was found by
  the live check, not by a test: the first web thread confidently told
  the operator it was in a Telegram chat, twice. The fix is a per-turn
  surface line from the event's own source, and the prompt naming no
  platform at all. Also shared out of the shell: the SSE stream and its
  hook, so an app-contributed page is live the same way every other page
  is.

- **2026-08-27 (Phase 4, slice A)** — The chat app became a service.
  Most of the slice was deciding what NOT to write twice: tg already had
  the env helpers, the internal-token guard, the bus wrappers, the
  operator client and the fetch plumbing, so all five were extracted
  (`@assistant-hub/service`, `internal-client.ts`, `operator-client.ts`)
  and tg moved onto them before chat got a line of its own. The core's
  source lookup is now keyed by source id, which is the coupling the
  phase criteria named first. The dashboard mount is generic too — one
  route for whichever app owns `/apps/<app>` — and making an
  app-contributed page look like a shell page meant moving the page
  chrome and the `<Timestamp>` timezone rule into `@assistant-hub/ui`.
  Checked in the running dashboard; the full listing path waits on a dev
  server restart, since `CHAT_API_URL` is read at boot.

- **2026-08-27 (Phase 4 opened)** — Phase 3 closed, Phase 4 started:
  the four design calls PLAN.md had left for this phase were put to the
  user and all four came back as the standing recommendation — apps/chat
  is a Hono service (tg's twin) whose dashboard UI renders inside the
  core Next build, content-plane parity is scoped to memory/traces/
  vision/voice (summaries, search index and analytics stay
  telegram-only), voice works in both directions, and chat implements
  the full outbound port so image generation, browser downloads and
  timed task fires can target a web thread. Acceptance criteria and the
  A–F slice plan written under "Phase 4 — Web chat". Three couplings
  were named up front as the things this phase must generalize rather
  than duplicate: the tg-hardcoded outbound/media ports, the shell's
  route mounting, and memory's tg-only ref keying.

- **2026-08-27 (live verification, Phase 3 closed)** — The operator
  restarted the dev services and ran both pending scenarios; verified
  from the traces, not from the chat. The DM check: two bots DM'd by
  the same person, one chat id, per-bot message numbering, each
  answering as its own assistant — and because both 24h windows
  happened to be empty, the scoped window read was checked against the
  live mirror instead, where each assistant sees only its own pair. The
  group check: one human message fanned out to both assistants, both
  name verdicts carrying their evidence, both cross-feeds answered, and
  the transcripts rendering mirror-image (each reader's own lines as
  "You", the other's under its name) — then the loop guard's two
  skipped traces with streak, limit and reason. 24 traces, zero errors,
  no orphaned turn markers.
  One open question closed by the run: Telegram silently refuses a
  reply target that is another bot's message. The readback added in
  `0097168` is why that is a recorded fact with a warn on it rather
  than a mystery about missing reply arrows.

- **2026-08-27 (slice F)** — The last Phase 3 slice, in two commits.
  `70785a3`: the dashboard's people and chats pages stopped reading the
  transitional v1 shadow and became an aggregation over a registry of
  source apps, each serving the shared operator listing contract — rows
  tagged with their origin and scoped ref, an unreachable source named
  above the table instead of silently shortening it, and curated edits
  routed to the owning source by ref (`/api/users/<ref>`,
  `/api/groups/<ref>`, `/groups/[ref]`). The contract grew
  `memberCount`, a single-chat GET and a roster endpoint so the detail
  page shows the participants the source actually injects.
  `ee9abd1`: person links got their feature — CRUD over the store tables
  Phase 1 created, on a second Users tab — and memory reads resolve
  through them, so knowledge follows the human rather than the account.
  Reads only, best-effort, telegram-keyed until Phase 6; every one of
  those three limits is a line in the code with a reason next to it.
  Nothing needed a user decision: the criterion was specific and the
  design questions it left (where the links UI lives, what a link of one
  identity means, whether writes resolve too) had answers the existing
  conventions already implied — tabs over a new nav entry, delete over
  shrink, reads over rewrites.

- **2026-08-24 (live test, round 4 — the reasoning leak)** — The operator's
  bot answered with raw chain-of-thought again. Probed the endpoint
  directly (see the TODO entry "The served model leaks its deliberation"
  for the tables): the served model stops using its thought channel at
  production prompt scale and writes its working-out as the answer —
  10/10 on the exact failing request, `reasoning_content` empty every
  time; server parsing, truncation, tools and temperature all ruled out
  by measurement. Thinking-off is the only thing that stops it outright
  and the user rejected that outright. Shipped instead, at the user's
  direction: a mechanical **reply-integrity gate** (truncated at the cap
  / input-only transcript anchor / raw channel markers) that retries once
  with a correction and suppresses a second failure — verified live with
  the shipped code, 6/6 caught and 6/6 recovered, 0 false positives over
  8 ordinary turns. Also, scoped to llama.cpp per the user: stop sending
  `reasoning_format: "none"`, which had been disabling the server's parse
  and putting `<|channel>thought<channel|>` markers into classifier
  replies (8/8).

- **2026-08-24 (live test, round 3)** — Addressing re-homed
  (`eeb3724`, user decision): summoning by name matches the
  ASSISTANT's name, never the bot account's profile name. First take
  denormalized the name into the tg store (column + bus event); the
  user rejected it — the name check is pure text, so it moved core-side
  instead: tg's `checkAddressed` is structural-only (reply/@mention/
  command/DM; group text → `needsAnalyzer`), and the core resolves the
  assistant identity once per turn (`getAssistantPromptIdentity`) for
  the name regex, the analyzer, exclusions, and the persona. No schema,
  no denormalization, renames effective immediately. Restart both dev
  services.

- **2026-08-24 (live test, round 2)** — Three more fixes (`b8ebf18`):
  the honesty gate now judges with the reply's own conversation window
  (it had suppressed a true "I've already told you" as a fabricated
  action — trace 10e34de6…) and its rules state that speech about the
  chat is never an action; the typing indicator resolves its sender per
  turn from the lifecycle event's assistant (was senderFor(null) — only
  the first running bot ever typed); and transcripts label the
  assistant's own lines plain "You" instead of "You (@username)" — the
  account handle confused a model that already knows its assistant name
  (all three user decisions). Both dev services need a restart.

- **2026-08-24 (slice D live test → DM streams)** — The operator's
  two-bot test surfaced an identity mix-up: the second assistant ran on
  the original bot account and answered from the merged DM history as the
  old persona (trace-verified: the persona DID compose; the transcript
  and the shared v1 memory/self-corrections pulled the other way). Two
  user decisions, both applied (`b34c247`): per-assistant DM streams in
  the tg mirror (details under the new Phase 3 criterion), and the
  structural "You are <name>." identity line in the persona block. Known
  leak that stays until Phase 6 BY DESIGN: memory and self-improvement
  are global, so one assistant's learned corrections and memories phrase
  themselves into the other's prompt. Both services need an operator
  restart to pick the changes up.

- **2026-08-24 (slice D)** — Per-assistant connections
  (`e78cede`): the extension registry gains `assistantSections`
  and its first real consumer — the new `@assistant-hub/tg-ui`
  workspace (`apps/tg/ui`) injects the Telegram connection section into
  the assistant editor; shared form primitives moved to
  `@assistant-hub/ui`; core proxies `/api/telegram/connections`; the
  Settings bot-token field retired (per-assistant tokens live in the
  editor — flagged for the user since it removes a Settings control),
  the Overview control went per-connection, and the sidebar summarizes
  across connections. New workspace wiring: root `apps/*/ui` glob,
  transpilePackages, Tailwind `@source`, and the core Dockerfile's deps
  stage copies the tg-ui manifest. Fix along the way (pre-existing,
  reproduced on clean HEAD): the turn-consumer integration suite let
  production code open the process-global store pool and never closed
  it, so the stopping Testcontainer killed its clients and 2 unhandled
  57P01 errors failed an all-tests-passing run — `closeStorePool()`
  added to `server/store/db` and called in the suite's teardown.
  Proof: root turbo typecheck/lint/test green (core unit 1121 incl.
  the new summarize suite); core integration 322/30-skipped green with
  a real exit code, tg 54 (incl. the new two-connection case), chat
  green; build green. Remaining: the operator-run two-live-bots check
  (Current state).

- **2026-08-24 (Phase 3 start)** — Phase 2 closed and Phase 3 opened in
  one session. User decisions: assistant-scoped store flip now (persona
  + tasks → v2 core store; memory/settings stay v1 until Phase 6);
  loop-guard default N=3; dev core store populated via the core import
  (verification passed); MCP-outbound shape confirmed (REST + core-side
  bindings — the slice-D flag closes). Phase 3 acceptance criteria
  written. Fix along the way: the core import entry wrapped in main()
  (CJS package, top-level await).

- **2026-08-24 (trace client)** — The last code criterion of Phase 2
  (`8428ea7`): the shared source-trace recorder in contracts, the
  core's `trace.recorded` ingest, and tg's first instrumentation
  (inbound / feedback collection / delivery). Phase 2 now blocks only
  on the operator-run live topology smoke — and the standing
  MCP-outbound design confirmation.
- **2026-08-24 (analytics re-route)** — The flip blocker cleared
  (`fe56e5f`): analytics reads the living mirror over the tg content
  API (details under the apps/core criterion and Current state item 1).
  Proof: tg integration 52 (incl. the new 9-test analytics-SQL suite),
  core integration 326/30-skipped with the ~800-line analytics suite
  reworked onto the fake, root turbo green. Phase 2's remaining work is
  the trace client and the operator-run live smoke.
- **2026-08-23/24 (the swap)** — The Phase 2 finale executed across nine
  commits (list under the apps/core criterion): outbound features onto
  the port, dashboard controls onto the operator API, the
  `server/telegram` deletion with feedback learning re-seamed onto
  `feedback.recorded`, the transitional shadow directory, vision and
  the whole content plane (history/summaries/search/memory-extraction)
  onto tg's internal API, the SSE bridge, the task-authority rework
  (owner stamps replace id comparison; core migration 0059), and the
  `assistant-hub-tg` Docker image + compose + release matrix. Proof:
  root turbo lint/typecheck/test/build green; core unit 1116 passed,
  core integration 326 passed / 30 skipped; tg integration 43 passed;
  migration 0059 applied to the core dev DB; `docker compose config`
  valid. Risks/remaining: the analytics flip blocker, the trace
  client, and the operator-run live smoke — ordered in Current state.
  Still awaiting user confirmation: the slice-D MCP-outbound design
  call.
- **2026-08-23 (slice D)** — The last extraction slice, in three commits
  (details under the Phase 2 criteria): D-1 the outbound surface (tg
  transport boundary with HTML + mirror-checked `#id` links, the
  internal send API for text/voice/photos/delete/reaction, `silent` on
  reply-delivery replacing `preferVoice`, the core's
  `SourceOutboundPort` closing the voice/images/acks/reaction consumer
  gaps); D-2 feedback flows tg-local (reaction → menu → answer on the
  tg store, free-text capture ahead of the turn, the `feedback.recorded`
  bus event, `feedbacks.model` nullable via tg migration 0001); D-3 the
  operator API (shared listing/CRUD contract in contracts, users/chats/
  messages/connections/settings on `/internal`, connection writes
  reconciling pollers). Proof: typecheck/lint/build green from the
  root; unit suites green; integration green (tg 28 across 6 files —
  outbound API 8, feedback 6, operator 5, media 4, runtime 3, import 2;
  core turn-consumer 10 incl. the 2 new voice-delivery cases). Flagged
  for the user: the MCP-outbound design call. Deferred to the swap: the
  swap-deferral list under the slice D notes.
- **2026-08-21** — Brainstorm session: all core decisions made by the user
  (monorepo/Turborepo, web+worker apps, Redis, canonical identity,
  assistants, web chat shape, MCP HTTP-only v1, big-bang on a rebased
  long-lived branch, brain-only migration with mandatory rehearsal).
  PLAN.md and PROGRESS.md created; TODO.md entry reduced to a pointer.
  Open: repo name, bot-to-bot loop guard, queue retry semantics, image
  shape.
- **2026-08-21 (later)** — Name decided: **assistant-hub**. Bot-to-bot loop
  guard approved: cap on consecutive assistant-authored turns per chat,
  operator-configurable. Remaining open items: queue retry semantics
  (Phase 2), image shape (Phase 0).
- **2026-08-21 (later still)** — Final two decisions: turn failure handling
  and deployment as two Docker images (`assistant-hub-web`,
  `assistant-hub-worker`) published together from one version bump. Turn
  handling was first agreed as ACID-like compensation, then revised by the
  user the same day to the simpler rule: retry only if the turn performed
  no actions yet; otherwise fail, report, stop — no revert machinery.
  Planning is complete.
- **2026-08-21 (evening)** — Topology revised by the user: **three** runtime
  apps, not two. `apps/tg` becomes a dedicated Telegram source app (pollers,
  inbound events, media ingestion, own MCP server with send_message /
  send_reply / typing tools); the worker keeps the pipeline and has no
  Telegram code. A formal source-app contract goes into packages/contracts
  (web chat and future sources implement the same shape). Reply path:
  deterministic replies travel as bus events the source app delivers;
  model-driven sends use the source app's MCP tools. Deployment becomes
  three per-app images.
- **2026-08-21 (night)** — Two more user revisions. (1) Web chat becomes
  its own source app, `apps/chat`, same contract as tg; `apps/web` is a
  pure dashboard shell + API + auth + SSE bridge + proxy, no longer a
  source. (2) The dashboard goes micro-frontend: app-owned UI packages
  (tg-ui, chat-ui) inject typed extensions (nav/routes, assistant-form
  sections, status cards) into the shell via a build-time extension
  registry (chosen over runtime module federation); source-app operator
  APIs are reached through the apps/web proxy on a single origin. Images:
  four. PLAN.md also rewritten this session as a history-free source of
  truth.
- **2026-08-21 (late night)** — Data model inverted by the user: canonical
  core entities are dropped in favor of **federation** — each app owns its
  own storage (its own logical database, schema, and migration chain):
  tg owns telegram users/chats/messages/media/connections, chat owns
  threads/messages, worker owns the core store (assistants, memory,
  tasks, settings, tool connections), web owns only sessions/prefs. The
  worker never reads a source's store — the source supplies conversation
  context (history window, participants) with the inbound event or on
  demand. Cross-app references are scoped refs (tg:chat:123); the same
  human across sources is joined by an operator-managed person-link table
  in the core store, which memory resolves through. The dashboard
  aggregates users/chats/messages via a shared listing/CRUD contract each
  source app's operator API implements. Migration now splits the v1 DB
  into the per-app databases.
- **2026-08-21 (later)** — apps/web and apps/worker merged into a single
  **apps/core** (user): with the sources carved out, the worker was just
  the brain and the web app just the shell, and the user wants the core
  store owned by the dashboard-owning app — so one hub app owns dashboard
  + auth + SSE + proxy + pipeline + MCP runtime + schedulers + core
  store, with no internal worker API needed. Three apps, three images
  (core/tg/chat). Phase 2 becomes "source split" (extract telegram from
  core) instead of a web/worker split.
- **2026-08-21 (last)** — Four refinements (user): typing is not an MCP
  tool — the core publishes turn-lifecycle events (accepted / progress /
  settled) and each source renders them natively (tg typing indicator,
  web thread progress); the chat app owns its own users (operator gets a
  chat user, linkable via person links); and the dashboard UI packages
  move inside their apps (apps/tg/ui, apps/chat/ui) as the one sanctioned
  seam the shell composes at build time.
- **2026-08-22 (Phase 2 start)** — Acceptance criteria written; boundary
  study done (the injected `BotMessagingDeps` seam splits cleanly —
  inventory in the criteria). Source-app event contract landed in
  contracts (inbound with context + resolved isOwner, reply-delivery,
  turn lifecycle, queue/channel names) and `@assistant-hub/bus` built on
  BullMQ/ioredis with the decided `attempts: 1` semantics — both tested,
  the bus against a real Redis (exactly-once, failure stays failed,
  poisoned pub/sub message survives). Compose gained the `redis` service
  (AOF + volume). Feedback/reaction bus events deliberately deferred to
  the extraction (their consumers shape them). Next: tg internal API
  design, then the additive runtime build (see Current state).
- **2026-08-22 (Phase 1 revision)** — User answered the open questions and
  the stores were reworked to match before Phase 2: the strict placement
  rule (bot state → core; conversation-derived content → owning app;
  "core just provides tools and features") moved chat summaries into the
  tg store (`summaries`, plain telegram ids, identity-preserving import);
  the job coverage markers (chat_summary_days, memory_extraction_days)
  stay core as job state (user choice on the follow-up question). Owner
  identity moved out of core settings into a new tg-store settings
  singleton (user choice: app-level, not per-connection) — the core will
  receive only the resolved is-owner flag on inbound events;
  `maintenance_mode_enabled` stays core. Queue retry semantics confirmed:
  BullMQ `attempts: 1`, re-enqueue decided by the turn runner via the
  actions-started marker. Both 0000 migrations regenerated; imports,
  verification and integration tests updated.
- **2026-08-21/22 (Phase 1)** — Phase 1 executed and verified: scoped-ref
  foundation + shared `EMBEDDING_DIMENSIONS` + `DEFAULT_ASSISTANT_ID` in
  `@assistant-hub/contracts`; three store modules with fresh migration
  chains (`apps/core/store`, `apps/tg/store`, `apps/chat/store` — apps/tg
  and apps/chat created as store-only workspaces, runtimes land in Phases
  2/4); person_links + members in the core store; one-shot per-app import
  scripts with the built-in count-reconciliation + spot-check harness
  (plumbing shared via `@assistant-hub/db/import`, Testcontainers helpers
  via `/testing`); rehearsal workflow documented in
  docs/operations/v1-split.md with a create-database helper. Placement
  calls made in-session and flagged for user confirmation (see Current
  state): summaries/day-markers/exclusions → core with scoped refs;
  message_search/feedbacks → tg; both import scripts derive the default
  assistant identically (active personality id, else `assistant-default`).
  Notable fix: tg 0000 migration needed the messages unique index moved
  above the composite FKs (drizzle-kit orders indexes after constraints).
- **2026-08-21 (Phase 0)** — `redesign` branch created; Phase 0 executed
  and verified in one session: Turborepo + npm workspaces, the whole app
  `git mv`-ed into `apps/core`, `@assistant-hub/db` / `contracts` / `ui`
  carved out (pool singleton + migration runner; documented empty
  contracts; extension-point types + `composeNavGroups` with an empty
  registry composed into the shell nav), per-app Docker image
  (`assistant-hub-core`, monorepo standalone) and the release workflow
  reshaped to a tag-once + per-image matrix on the root version. Full
  proof under the Phase 0 acceptance criteria above. Naming decision made
  in-session: workspace packages use the `@assistant-hub/*` scope ahead of
  the Phase 6 repo rename; the root package keeps the v1 name/version so
  build info and the release trigger are unchanged until cutover.
- **2026-08-21 (traces)** — Tracing unified (user): the core owns all
  trace storage and provides the recording functions; apps record through
  a shared trace client that delivers events to the core over the bus.
  Replaces per-app trace stores and cross-store stitching — the debug
  explorer reads one store, correlation ids still tie a turn's cross-app
  flow into one trace.
