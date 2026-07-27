# Documentation

Full documentation for **llm-tg-bot-nextjs** — a Telegram bot driven by an
OpenAI-compatible LLM, with an operator dashboard for control, configuration and
observability.

Everything here describes the code in this repository. Pending and upcoming
work — features with their agreed specs and decisions, plus open operational
items — is tracked in [TODO](TODO.md). (The rewrite-era planning files,
`NEXTJS_REWRITE_PLAN.md` and `NEXTJS_REWRITE_PROGRESS.md`, were retired on
2026-07-27; their history lives in git.)

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

**I want to call the API.**
[API conventions](api/README.md) → [Endpoint reference](api/endpoints.md) →
[`openapi.yaml`](api/openapi.yaml)

## Contents

### Setup

| Document | What it covers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, local install, database, first run, first-run password |
| [Configuration](configuration.md) | The two config layers: bootstrap env vars and every DB-backed setting |

### Architecture

| Document | What it covers |
| --- | --- |
| [Overview](architecture/overview.md) | Layers, module boundaries, process singletons, request lifecycle |
| [Data model](architecture/data-model.md) | Every Postgres table and column, relationships, migrations |
| [Telegram pipeline](architecture/telegram-pipeline.md) | An incoming update end to end: addressing → context → tools → reply |
| [Background jobs](architecture/background-jobs.md) | The three scheduler primitives, advisory locks, progress, the Jobs board |
| [LLM and MCP](architecture/llm-and-mcp.md) | The five provider clients, the tool-call loop, the MCP registry, tool catalog |
| [Observability](architecture/observability.md) | The trace contract, the file-backed trace store, Debug UI, live SSE updates |
| [Security](architecture/security.md) | Operator auth, secret handling, SSRF defense, prompt-injection posture, data sensitivity |

### Features

[Feature index](features/README.md) — one document per product feature, each with
its behavior, configuration, data, traces and tests.

### API

| Document | What it covers |
| --- | --- |
| [Conventions](api/README.md) | Response envelope, error codes, auth, downloads, SSE |
| [Endpoint reference](api/endpoints.md) | Every route grouped by feature, with request/response shapes |
| [`openapi.yaml`](api/openapi.yaml) | OpenAPI 3.1 description of the whole HTTP surface |

### Operations

| Document | What it covers |
| --- | --- |
| [Deployment](operations/deployment.md) | Docker Compose, the image, migrations on start, health checks, releases |
| [Operator guide](operations/operator-guide.md) | Every dashboard page and what to do on it |
| [Using the bot in chat](operations/using-the-bot.md) | What end users can do in Telegram, and how the bot decides to answer |
| [Backup and restore](operations/backup-and-restore.md) | What state exists, where, and how to back each part up |
| [Troubleshooting](operations/troubleshooting.md) | Symptom → cause → fix, with the trace to look at |

### Development

| Document | What it covers |
| --- | --- |
| [Contributing](development/contributing.md) | Engineering standards, the feature contract, where code goes |
| [Testing](development/testing.md) | Unit tests, Testcontainers integration tests, the bot-less simulation harness |
| [UI kit](development/ui-kit.md) | The design system, shared components, and the UI conventions features must follow |
| [TODO](TODO.md) | The working tracker: pending features with their agreed specs, and open items |

## Conventions used in these docs

- Paths are repo-relative (`features/history/server/service.ts`).
- "Operator" is whoever holds the dashboard password. "Owner" is the Telegram
  user configured as the bot's owner in Settings — a different concept.
- Times shown in the dashboard are always rendered in the configured operator
  timezone, never the viewer's local zone.
- Where a doc states a decision was the user's, it was made by asking the user
  directly. Decisions for pending work are recorded in [TODO](TODO.md); the
  historical Decision Notes table lives in git history
  (`NEXTJS_REWRITE_PROGRESS.md`, retired 2026-07-27).
