# Features

One document per product feature. Each covers what the feature does, how it
decides, what it stores, how it is configured, what it traces, and where its tests
live.

Feature ids are the ones in `lib/features.ts` — the same strings that appear as
`feature` on every trace and as the `/debug?feature=<id>` filter. Paths are
relative to `apps/core/` unless they start with `apps/` or `packages/`.

## Index

| Feature | Ids | Dashboard | Doc |
| --- | --- | --- | --- |
| Bot messaging (the reply pipeline) | `bot-messaging` | Overview (bot status), `/debug` | [bot-messaging.md](bot-messaging.md) |
| Assistants | `assistants` | `/assistants` | [assistants.md](assistants.md) |
| Accounts, roles, identity links | `auth`, `accounts` | `/accounts`, `/profile`, `/login`, `/setup` | [accounts.md](accounts.md) |
| Web chat | `mcp-tools-web-chat` | `/chat` | [web-chat.md](web-chat.md) |
| Tasks (standing rules + timed jobs) | `tasks`, `mcp-tools-tasks` | `/tasks` | [tasks.md](tasks.md) |
| History | `history`, `history-summaries`, `history-index`, `mcp-tools-history` | `/history`, `/search` | [history.md](history.md) |
| Memory | `memory`, `memory-extraction`, `mcp-tools-memory` | `/memory` | [memory.md](memory.md) |
| Vision | `vision`, `vision-backfill` | `/vision` | [vision.md](vision.md) |
| Voice | `voice` | `/vision` | [voice.md](voice.md) |
| Image generation | `mcp-tools-image-gen` | `/tools`, `/vision` | [image-generation.md](image-generation.md) |
| Randomness (`roll_chance`) | `mcp-tools-randomness` | `/tools` | [randomness.md](randomness.md) |
| Browser agent (all web access) | `browser-agent`, `mcp-tools-browser-agent`, `ytdlp-updater` | `/browser` | [browser-agent.md](browser-agent.md) |
| Self-improvement | `user-feedback`, `self-improvement` | `/self-improvement` | [self-improvement.md](self-improvement.md) |
| Analytics | `analytics`, `analytics-insights` | `/analytics` | [analytics.md](analytics.md) |
| Users, groups and person links | `known-users`, `known-groups`, `person-links`, `mcp-tools-known-users` | `/users`, `/groups` | [known-users-and-groups.md](known-users-and-groups.md) |
| Settings | `settings` | `/settings` | [settings.md](settings.md) |
| Backends catalog | `backends` | `/backends` | [backends.md](backends.md) |
| Tool connections (remote MCP servers, incl. the transports' own) | `tool-connections`, `mcp-tools-connections` | `/tools` | [tool-connections.md](tool-connections.md) |
| Transports (Telegram) | traces under `tool-connections` (registrations, connections) and `bot-messaging` (deliveries) | The assistant editor's connection sections | [../development/adding-a-transport.md](../development/adding-a-transport.md) |
| In-process MCP tools runtime | — | `/tools` | [../architecture/llm-and-mcp.md](../architecture/llm-and-mcp.md) |
| Traces / Debug | `traces` | `/debug` | [../architecture/observability.md](../architecture/observability.md) |
| Background jobs board | — | `/jobs` | [../architecture/background-jobs.md](../architecture/background-jobs.md) |
| Browsing infrastructure (no tool) | — | — | [link-fetch.md](link-fetch.md) |
| Search fallback, Tavily (no tool) | — | `/settings` | [web-search.md](web-search.md) |

## What shapes a reply

Most features exist to influence one thing: what the model sees when it answers a
message. In prompt order:

| Layer | Feature | Always present? |
| --- | --- | --- |
| Base system prompt | Bot messaging (code-owned constant) | Yes |
| Persona ("Additional instructions", with the assistant's identity line) | Assistants | The identity line always; the persona when the assistant has one |
| Self-correction guidelines | Self-improvement | When any version exists |
| Standing tasks (rules) | Tasks | When the assistant has any for this chat (or globally) |
| Chat context (roster, group notes) | Users and groups | When there is anything to inject |
| Long-term memory | Memory | When the bot knows anything about the people here (never on a cross-fed turn) |
| Sender preferences | Self-improvement | When the sender has a version |
| Group addressing hint | Bot messaging | Groups only |
| History transcript (last 24h) | History | When the chat has recent messages |
| Time context | Bot messaging | Yes |
| Language directive | Users and groups | Yes |
| Current turn (+ media resolved to text) | Bot messaging, Vision, Voice | Yes — image bytes never reach the reply request |
| Tools | In-process feature tools, plus every tool connection in scope (the transport's own on its turns) | Always; the delivery tools by turn kind |

The full assembly and the reasoning behind the ordering are in
[the message pipeline](../architecture/telegram-pipeline.md#stage-5--composing-the-reply).

## Merged features

**Chat rules** and **Scheduled tasks** merged into the single **Tasks** feature
(user decision, 2026-08-13): a task is one instruction plus one trigger
(`message` / `on-reply` / `interval` / `timeout` / `schedule`), and timed fires
deliver through the source's outbound tools instead of a hardcoded send. See
[tasks.md](tasks.md).

**Personalities** became **Assistants** (v2 redesign, Phase 3): many
assistants, each with its own persona, owner account and per-transport bot
connection, and no "active" selection — the assistant in a chat is implied by
which bot is in it. See [assistants.md](assistants.md).

## Dropped features

**Mood** — the bot's own mood state injected into replies — is deprecated and
dropped (user decision, 2026-07-16). Reply behavior comes from the base system
prompt plus the assistant's persona only. This does not touch the analytics-only
mood score, which stays.

**Specialists** — per-chat operator-authored roles with a shared entry-store
toolkit — was removed completely (user decision, 2026-08-19): dashboard page,
Route Handlers, MCP tools, prompt layer, and its tables, none of which exist in
the v2 store.
