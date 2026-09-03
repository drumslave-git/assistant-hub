# Documentation

Full documentation for **assistant-hub** — a multi-user assistant platform:
accounts run their own AI assistants (personas, Telegram bots, standing tasks,
tools) on one shared brain (an OpenAI-compatible chat completions API, or a
native Anthropic, Google or Z.ai backend), with a web chat and a
control/observability dashboard. The platform is two apps: the **core**
(dashboard, web chat, the whole pipeline, one Postgres database) and a
stateless **Telegram transport** that registers with it; another messaging
platform connects the same way.

Everything here describes the code in this repository. Pending and upcoming
work — features with their agreed specs and decisions, plus open operational
items — is tracked in [TODO](TODO.md). The v2 redesign's design is
[PLAN](PLAN.md) and its completed record is [PROGRESS](PROGRESS.md) (history,
not open work).

## Reading paths

**I want to run it.**
[Getting started](getting-started.md) → [Configuration](configuration.md) →
[Deployment](operations/deployment.md)

**I operate it day to day.**
[Operator guide](operations/operator-guide.md) →
[Using the bot in chat](operations/using-the-bot.md) →
[Troubleshooting](operations/troubleshooting.md) →
[Backup and restore](operations/backup-and-restore.md)

**I want to understand or change the code.**
[Architecture overview](architecture/overview.md) →
[Contributing](development/contributing.md) →
[Feature docs](features/README.md) →
[Testing](development/testing.md)

**I want to connect another messaging platform.**
[Adding a transport](development/adding-a-transport.md) — the contract, step
by step, with the Telegram app as the worked example.

**I want to call the API.**
[API conventions](api/README.md) → [Endpoint reference](api/endpoints.md) →
[`openapi.yaml`](api/openapi.yaml)

## Contents

### Setup

| Document | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, local install, database and Redis, first run, the first admin, connecting a bot |
| [Configuration](configuration.md) | The two config layers: bootstrap env vars for both apps, and every DB-backed setting |

### Architecture

| Document | What it covers |
| --- | --- |
| [Overview](architecture/overview.md) | The two apps and the shared packages, layers, the cross-app message lifecycle, process singletons, boot |
| [Data model](architecture/data-model.md) | Every Postgres table and column, relationships, migrations |
| [The message pipeline](architecture/telegram-pipeline.md) | An incoming message end to end: transport → ingest → addressing → context → tools → delivery |
| [Background jobs](architecture/background-jobs.md) | The three scheduler primitives, advisory locks, progress, the Jobs board |
| [LLM and MCP](architecture/llm-and-mcp.md) | The provider clients, the tool loop, in-process and remote MCP tools, the tool catalog |
| [Observability](architecture/observability.md) | The trace contract across apps, the file-backed trace store, Debug UI, live SSE updates |
| [Security](architecture/security.md) | Accounts and roles, the internal token, secret handling, SSRF defense, prompt-injection posture, data sensitivity |

### Features

[Feature index](features/README.md) — one document per product feature, each with
its behavior, configuration, data, traces and tests.

### API

| Document | What it covers |
| --- | --- |
| [Conventions](api/README.md) | Response envelope, error codes, access levels, the internal token, downloads, SSE |
| [Endpoint reference](api/endpoints.md) | Every route grouped by feature, with request/response shapes |
| [`openapi.yaml`](api/openapi.yaml) | OpenAPI 3.1 description of the whole HTTP surface |

### Operations

| Document | What it covers |
| --- | --- |
| [Deployment](operations/deployment.md) | Docker Compose (core, Telegram service, Redis, Postgres), the images, migrations on start, health checks, releases |
| [Operator guide](operations/operator-guide.md) | Every dashboard page and what to do on it |
| [Using the bot in chat](operations/using-the-bot.md) | What end users can do in Telegram, and how an assistant decides to answer |
| [Backup and restore](operations/backup-and-restore.md) | What state exists, where, and how to back each part up |
| [Troubleshooting](operations/troubleshooting.md) | Symptom → cause → fix, with the trace to look at |

### Development

| Document | What it covers |
| --- | --- |
| [Contributing](development/contributing.md) | Engineering standards, the feature contract, where code goes |
| [Adding a transport](development/adding-a-transport.md) | The transport contract, for an author with no access to this repository: registration, events, delivery, the HTTP surface, MCP tools, shipping an image |
| [Testing](development/testing.md) | Unit tests, Testcontainers integration tests, exercising the pipeline without Telegram |
| [UI kit](development/ui-kit.md) | The design system, shared components, and the UI conventions features must follow |
| [TODO](TODO.md) | The working tracker: pending features with their agreed specs, and open items |

## Conventions used in these docs

- Paths are relative to `apps/core/` unless they start with `apps/` or
  `packages/` (`features/history/server/service.ts` means
  `apps/core/features/history/server/service.ts`).
- "Admin" and "user" are the two account roles. An **operator** is whoever
  administers the deployment — an admin account. **Owner rights** in a chat
  belong to the assistant's owning account (resolved through identity links)
  and to every admin; there is no single global owner.
- A **source** is where a conversation lives — `tg` (Telegram) or `chat` (the
  web chat) — and a **transport** is the service that connects a platform
  source. Cross-app pointers are scoped refs, `tg:user:123`.
- Times shown in the dashboard are always rendered in the configured operator
  timezone, never the viewer's local zone.
- Where a doc states a decision was the user's, it was made by asking the user
  directly. Decisions for pending work are recorded in [TODO](TODO.md); the
  redesign's decisions are in [PROGRESS](PROGRESS.md).
