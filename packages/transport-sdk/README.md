# `@assistant-hub-swarm/transport-sdk`

Everything a **transport** needs to connect a messaging platform (Discord,
Signal, Matrix, Slack, …) to a running [assistant-hub][core] core: the wire
contracts, the Redis queue and bus helpers, the internal-token guard, an MCP
server over Hono, the trace client and image normalization.

A transport is a stateless service that owns exactly one platform. It has no
database and no files. It registers with a core at boot, forwards every update
it sees as normalized events, performs the sends the core asks for, and hosts
its platform's own actions as MCP tools. The core needs **no changes** to
accept one: you pick your own source id, announce it, and appear on the
dashboard.

- **The manual**: [Adding a transport][manual] walks the whole contract in the
  order you meet it, with a worked example.
- **The wire, language-neutral**: [JSON Schema][schema] for every event and
  [OpenAPI][openapi] for the HTTP in both directions, generated from the same
  zod schemas this package exports and checked against them in CI.

## Install

The package is published to **GitHub Packages**, so npm needs to know where to
look for the `@assistant-hub-swarm` scope. In your project:

```
# .npmrc
@assistant-hub-swarm:registry=https://npm.pkg.github.com
```

That registry wants a **token on every request**: a package published there is
readable by any account once it is public, but not anonymously. Put one with
`read:packages` in your user-level `~/.npmrc`, where it stays out of every
repository you write:

```
//npm.pkg.github.com/:_authToken=<token>
```

In CI it is the workflow's own `GITHUB_TOKEN`; in an image build, pass it as a
BuildKit secret rather than a build arg, so it never lands in a layer.

```bash
npm install @assistant-hub-swarm/transport-sdk hono @hono/node-server @modelcontextprotocol/sdk zod
```

Those four are **peer dependencies**: you construct Hono apps, `McpServer`s and
zod schemas and hand them to the SDK, so you and the SDK must share one copy of
each. Everything else the SDK needs (BullMQ, ioredis, sharp) it installs
itself.

## The two versions

| | What it covers | Where it lives |
| --- | --- | --- |
| This package's **semver** | The TypeScript API — the exports below | `package.json` |
| `CONTRACT_MAJOR` | The **wire** — events, internal routes, the registration shape | exported from this package |

Announce `CONTRACT_MAJOR` at registration. A core that speaks another major
refuses you **by name**, with a reason its dashboard shows next to your
transport — never a silent drop. When that happens, bump the SDK and rebuild;
the manual's "Before you start" has the exact failure.

## Ten lines of it

```ts
import {
  CONTRACT_MAJOR,
  TRANSPORT_UPDATES_QUEUE,
  openQueue,
  requireEnv,
  scopedRef,
  transportRegistrationRequestSchema,
} from "@assistant-hub-swarm/transport-sdk";

const updates = openQueue(TRANSPORT_UPDATES_QUEUE, requireEnv("REDIS_URL"));

const registration = transportRegistrationRequestSchema.parse({
  id: "discord",
  name: "Discord",
  contractMajor: CONTRACT_MAJOR,
  baseUrl: process.env.SELF_URL ?? "http://localhost:3220",
  mcpPath: "/mcp",
  connectionConfigSchema: [
    { key: "botToken", label: "Bot token", type: "secret", required: true },
  ],
  transportConfigSchema: [],
});
// POST it to {CORE_API_URL}/api/internal/transports/register with the
// x-internal-token header; the answer is your desired state.

await updates.add("update", {
  /* transportMessageEventSchema — every message you see, addressed or not */
});

console.log(scopedRef("discord", "chat", "1183…")); // discord:chat:1183…
```

## What is in here

| Group | For |
| --- | --- |
| Scoped refs (`scopedRef`, `parseScopedRef`, `SOURCE_ID_PATTERN`) | Naming a chat, a person or a message across apps without a foreign key |
| `CONTRACT_MAJOR` | The handshake at registration |
| `transport*` schemas + `TRANSPORT_UPDATES_QUEUE` | Registering, receiving desired state, publishing every update |
| `inboundMessageEvent*`, `replyDelivery*`, `turnLifecycle*`, `BUS_EVENTS_CHANNEL`, `turnCorrelationId`, `messageDedupeKey` | What the core publishes back, and the ids one turn shares |
| `internal*` schemas | The HTTP surface the core calls on you (voice, photos, files, menus, deletes) |
| `readTurnMeta`, `toolDeliveryResult`, `TURN_META_KEY` | Your MCP tools: the turn they are bound to, the delivery they report |
| `busTraceClient`, `createSourceTraceRecorder` | Recording what you did into the core's one debug explorer |
| `openQueue`, `openWorker`, `openPublisher`, `openSubscriber` | Redis, wired the way the core expects (`attempts: 1` — the turn runner alone decides re-enqueue) |
| `internalTokenGuard`, `INTERNAL_TOKEN_HEADER`, `serveMcp`, `requireEnv` | Your HTTP surface |
| `normalizeImageForChat` | Turning platform media into the bounded JPEG the core's vision endpoints accept |

Deliberately **not** here: the core's dashboard DTOs, its operator listings and
its content plane. A transport never speaks them, they change with the
dashboard, and this package's semver would otherwise promise something it does
not control.

[core]: https://github.com/assistant-hub-swarm/ahw-core
[manual]: https://github.com/assistant-hub-swarm/ahw-core/blob/main/docs/development/adding-a-transport.md
[schema]: https://github.com/assistant-hub-swarm/ahw-core/blob/main/docs/api/transport/events.schema.json
[openapi]: https://github.com/assistant-hub-swarm/ahw-core/blob/main/docs/api/transport/openapi.yaml
