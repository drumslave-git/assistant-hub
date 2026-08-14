# Features

One document per product feature. Each covers what the feature does, how it
decides, what it stores, how it is configured, what it traces, and where its tests
live.

Feature ids are the ones in `lib/features.ts` — the same strings that appear as
`feature` on every trace and as the `/debug?feature=<id>` filter.

## Index

| Feature | Ids | Dashboard | Doc |
| --- | --- | --- | --- |
| Bot messaging | `bot-messaging` | Overview (bot control) | [bot-messaging.md](bot-messaging.md) |
| Personalities | `personalities` | `/personalities` | [personalities.md](personalities.md) |
| Specialists | `specialists`, `mcp-tools-specialists` | `/specialists` | [specialists.md](specialists.md) |
| Tasks (standing rules + timed jobs) | `tasks`, `mcp-tools-tasks` | `/tasks` | [tasks.md](tasks.md) |
| History | `history`, `history-summaries` | `/history` | [history.md](history.md) |
| Memory | `memory`, `memory-extraction` | `/memory` | [memory.md](memory.md) |
| Vision | `vision`, `vision-backfill` | `/vision` | [vision.md](vision.md) |
| Voice | `voice` | `/vision` | [voice.md](voice.md) |
| Image generation | `mcp-tools-image-gen` | `/tools`, `/vision` | [image-generation.md](image-generation.md) |
| Randomness (`roll_chance`) | `mcp-tools-randomness` | `/tools` | [randomness.md](randomness.md) |
| Browser agent (all web access) | `browser-agent`, `mcp-tools-browser-agent`, `ytdlp-updater` | `/browser` | [browser-agent.md](browser-agent.md) |
| Self-improvement | `user-feedback`, `self-improvement` | `/self-improvement` | [self-improvement.md](self-improvement.md) |
| Analytics | `analytics`, `analytics-insights` | `/analytics` | [analytics.md](analytics.md) |
| Users and groups | `known-users`, `known-groups`, `mcp-tools-known-users` | `/users`, `/groups` | [known-users-and-groups.md](known-users-and-groups.md) |
| Settings | `settings` | `/settings` | [settings.md](settings.md) |
| MCP tools registry | — | `/tools` | [../architecture/llm-and-mcp.md](../architecture/llm-and-mcp.md) |
| Traces / Debug | `traces` | `/debug` | [../architecture/observability.md](../architecture/observability.md) |
| Auth | `auth` | `/login`, `/setup` | [../architecture/security.md](../architecture/security.md) |
| Browsing infrastructure (no tool) | — | — | [link-fetch.md](link-fetch.md) |
| Search fallback, Tavily (no tool) | — | `/settings` | [web-search.md](web-search.md) |

## What shapes a reply

Most features exist to influence one thing: what the model sees when it answers a
message. In prompt order:

| Layer | Feature | Always present? |
| --- | --- | --- |
| Base system prompt | Bot messaging (code-owned constant) | Yes |
| Personality | Personalities | When one is active |
| Specialist role | Specialists | When one is active in this chat |
| Self-correction guidelines | Self-improvement | When any version exists |
| Standing tasks (rules) | Tasks | When the chat (or the global set) has any |
| Chat context (roster, group notes) | Users and groups | When there is anything to inject |
| Long-term memory | Memory | When the bot knows anything about the people here |
| Sender preferences | Self-improvement | When the sender has a version |
| Group addressing hint | Bot messaging | Groups only |
| History transcript (last 24h) | History | When the chat has recent messages |
| Time context | Bot messaging | Yes |
| Language directive | Users and groups | Yes |
| Current turn (+ images) | Bot messaging, Vision, Voice | Yes |
| Tools | MCP registry | All registered tools, always |

The full assembly and the reasoning behind the ordering are in
[the Telegram pipeline](../architecture/telegram-pipeline.md#stage-6--composing-the-reply).

## Merged features

**Chat rules** and **Scheduled tasks** merged into the single **Tasks** feature
(user decision, 2026-08-13): a task is one instruction plus one trigger
(`message` / `on-reply` / `interval` / `timeout` / `schedule`), and timed fires
deliver through the outbound tools instead of a hardcoded send. See
[tasks.md](tasks.md).

## Dropped features

**Mood** — the bot's own mood state injected into replies — is deprecated and
dropped (user decision, 2026-07-16). Reply behavior comes from the base system
prompt plus the active personality only. This does not touch the analytics-only
mood score, which stays.
