/**
 * Generates the transport wire contract in language-neutral form, from the
 * zod schemas the SDK exports — the same objects the core parses with.
 *
 *   npm run wire:generate -w @assistant-hub-swarm/transport-sdk
 *
 * Two files land in `docs/api/transport/`:
 *
 *  - `events.schema.json` — JSON Schema (2020-12) for every event that crosses
 *    the Redis queue and bus, in both directions.
 *  - `openapi.yaml` — OpenAPI 3.1 for the HTTP in both directions: the surface
 *    the core calls on a transport, and the core's own transport API.
 *
 * A transport written in another language reads these instead of importing
 * TypeScript. **Shapes are never hand-written here**: only the prose (a route's
 * summary, what calls it) is, because zod cannot carry it. `wire.test.ts`
 * regenerates both files and fails when the committed copies differ, so the
 * shapes cannot drift from the code — the check runs in `npm run test`, which
 * is what CI runs before it releases anything.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { stringify } from "yaml";
import { z } from "zod";

import {
  CONTRACT_MAJOR,
  BUS_EVENTS_CHANNEL,
  TRANSPORT_UPDATES_QUEUE,
  assistantDeletedEventSchema,
  chatInfoSchema,
  connectionIdentitySchema,
  conversationContextSchema,
  dashboardRefreshEventSchema,
  inboundMessageEventSchema,
  internalDeleteMessageResponseSchema,
  internalEditMenuRequestSchema,
  internalSendFileRequestSchema,
  internalSendMenuRequestSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  internalSentFileResponseSchema,
  internalSentMenuResponseSchema,
  internalSentMessageResponseSchema,
  internalSentPhotosResponseSchema,
  internalSentVoiceResponseSchema,
  internalSetTitleRequestSchema,
  internalSetTitleResponseSchema,
  messageDeliveredEventSchema,
  replyDeliveryEventSchema,
  scopedRefSchema,
  sourceIdSchema,
  toolDeliverySchema,
  transportBotReactionEventSchema,
  transportCallbackRequestSchema,
  transportCallbackResponseSchema,
  transportConfigChangedEventSchema,
  transportDesiredStateSchema,
  transportEditEventSchema,
  transportMessageEventSchema,
  transportMessageLookupResponseSchema,
  transportPresenceEventSchema,
  transportReactionEventSchema,
  transportRegistrationRequestSchema,
  transportUpdateEventSchema,
  turnLifecycleEventSchema,
  turnToolMetaSchema,
} from "../src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", "..", "..", "docs", "api", "transport");

const REPO = "https://github.com/assistant-hub-swarm/ahw-core";
const MANUAL = `${REPO}/blob/main/docs/development/adding-a-transport.md`;

/**
 * `input` describes what a sender may put on the wire (a field with a default
 * is optional); `output` describes what a receiver gets (it is filled in). A
 * request body is an input, a response body and an event are outputs.
 */
type Io = "input" | "output";

interface Named {
  schema: z.ZodType;
  io: Io;
  /** One line, in the document — zod carries no prose. */
  note: string;
}

/** Every shape the wire contract names, grouped the way the manual walks them. */
const SHAPES: Record<string, Named> = {
  // Identity
  SourceId: {
    schema: sourceIdSchema,
    io: "output",
    note: "A transport's own id: a short lowercase slug it picks and announces. Becomes the prefix of every scoped ref and the namespace of its MCP tools.",
  },
  ScopedRef: {
    schema: scopedRefSchema,
    io: "output",
    note: "`source:kind:id` — how one app points at another's entity (`tg:user:12345`). The id is the owning app's own key, verbatim.",
  },

  // Registration and desired state
  TransportRegistrationRequest: {
    schema: transportRegistrationRequestSchema,
    io: "input",
    note: "POST /api/internal/transports/register — what a transport announces at boot, including the contract major it was built against.",
  },
  TransportDesiredState: {
    schema: transportDesiredStateSchema,
    io: "output",
    note: "What the core wants running: one entry per assistant connection, with the operator's config blobs. The answer to registration and to every refetch.",
  },
  ConnectionIdentity: {
    schema: connectionIdentitySchema,
    io: "output",
    note: "Who a transport's connection is on its platform, as it reports back on every event.",
  },

  // Transport -> core, over the update queue
  TransportUpdateEvent: {
    schema: transportUpdateEventSchema,
    io: "output",
    note: `The queue's payload union: one job per update on \`${TRANSPORT_UPDATES_QUEUE}\`.`,
  },
  TransportMessageEvent: {
    schema: transportMessageEventSchema,
    io: "output",
    note: "A new inbound message — every one the transport sees, addressed or not, with media bytes attached.",
  },
  TransportEditEvent: {
    schema: transportEditEventSchema,
    io: "output",
    note: "A message's text changed on the platform.",
  },
  TransportReactionEvent: {
    schema: transportReactionEventSchema,
    io: "output",
    note: "A person reacted to one of the assistant's messages — what opens the feedback flow.",
  },
  TransportBotReactionEvent: {
    schema: transportBotReactionEventSchema,
    io: "output",
    note: "The assistant's own reaction badge, as the platform now shows it.",
  },
  MessageDeliveredEvent: {
    schema: messageDeliveredEventSchema,
    io: "output",
    note: "The transport performed a send. Reported for EVERY send, whoever asked for it — this is how the core learns what is in the chat.",
  },
  TransportPresenceEvent: {
    schema: transportPresenceEventSchema,
    io: "output",
    note: "Which of the transport's connections can see a chat — the core resolves a message's audience from this, never from the transport.",
  },

  // Core -> transport, over the event bus
  ReplyDeliveryEvent: {
    schema: replyDeliveryEventSchema,
    io: "output",
    note: `Published on \`${BUS_EVENTS_CHANNEL}\`: one finished answer to deliver. The whole answer — the transport cuts it to its own limits.`,
  },
  TurnLifecycleEvent: {
    schema: turnLifecycleEventSchema,
    io: "output",
    note: "A turn was accepted, is progressing, or settled — render it as the platform's own activity indicator.",
  },
  TransportConfigChangedEvent: {
    schema: transportConfigChangedEventSchema,
    io: "output",
    note: "The operator changed something: refetch the desired state and reconcile.",
  },
  AssistantDeletedEvent: {
    schema: assistantDeletedEventSchema,
    io: "output",
    note: "An assistant is gone; stop anything running for it.",
  },
  DashboardRefreshEvent: {
    schema: dashboardRefreshEventSchema,
    io: "output",
    note: "A transport telling the core's dashboard that a page's data changed, so no operator has to reload.",
  },

  // What the core makes of an update (for reference — the core's own queue)
  InboundMessageEvent: {
    schema: inboundMessageEventSchema,
    io: "output",
    note: "For reference: what the core's ingest turns one message into — one turn per assistant that can see the chat, with the conversation context composed.",
  },
  ChatInfo: {
    schema: chatInfoSchema,
    io: "output",
    note: "A conversation as the pipeline reads it, named by scoped ref.",
  },
  ConversationContext: {
    schema: conversationContextSchema,
    io: "output",
    note: "The history window and participants the core composed for a turn.",
  },

  // MCP tools
  TurnToolMeta: {
    schema: turnToolMetaSchema,
    io: "output",
    note: "The turn binding the core attaches to every tool call as request `_meta` under `assistant-hub-swarm/turn`. Refuse a call that carries none, or one naming another source.",
  },
  ToolDelivery: {
    schema: toolDeliverySchema,
    io: "input",
    note: "What a delivery tool reports in `structuredContent` under `delivery`. The core learns a send happened from this shape, never from a tool's name.",
  },

  // The transport's HTTP surface (core -> transport)
  InternalSendMessageRequest: {
    schema: internalSendMessageRequestSchema,
    io: "input",
    note: "POST /internal/chats/{chatId}/messages",
  },
  InternalSentMessageResponse: {
    schema: internalSentMessageResponseSchema,
    io: "output",
    note: "The delivered message's own id, verbatim.",
  },
  InternalSendVoiceRequest: {
    schema: internalSendVoiceRequestSchema,
    io: "input",
    note: "POST /internal/chats/{chatId}/voice",
  },
  InternalSentVoiceResponse: {
    schema: internalSentVoiceResponseSchema,
    io: "output",
    note: "`asVoice: false` when the platform refused the voice bubble and the text was sent instead.",
  },
  InternalSendPhotosRequest: {
    schema: internalSendPhotosRequestSchema,
    io: "input",
    note: "POST /internal/chats/{chatId}/photos",
  },
  InternalSentPhotosResponse: {
    schema: internalSentPhotosResponseSchema,
    io: "output",
    note: "`stored: false` when the photo was sent but its media row could not be kept.",
  },
  InternalSendFileRequest: {
    schema: internalSendFileRequestSchema,
    io: "input",
    note: "POST /internal/chats/{chatId}/files",
  },
  InternalSentFileResponse: {
    schema: internalSentFileResponseSchema,
    io: "output",
    note: "The delivered file message's own id.",
  },
  InternalDeleteMessageResponse: {
    schema: internalDeleteMessageResponseSchema,
    io: "output",
    note: "`deleted: false` means the platform refused — cosmetic for every caller.",
  },
  InternalSendMenuRequest: {
    schema: internalSendMenuRequestSchema,
    io: "input",
    note: "POST /internal/chats/{chatId}/menu — a plain button grid the transport renders however its platform allows.",
  },
  InternalSentMenuResponse: {
    schema: internalSentMenuResponseSchema,
    io: "output",
    note: "The posted menu's message id.",
  },
  InternalEditMenuRequest: {
    schema: internalEditMenuRequestSchema,
    io: "input",
    note: "PATCH /internal/chats/{chatId}/menu/{messageId} — `keyboard: null` removes the buttons.",
  },
  InternalSetTitleRequest: {
    schema: internalSetTitleRequestSchema,
    io: "input",
    note: "PUT /internal/chats/{chatId}/title — only for platforms whose conversations arrive unnamed.",
  },
  InternalSetTitleResponse: {
    schema: internalSetTitleResponseSchema,
    io: "output",
    note: "The title the conversation now carries.",
  },

  // The core's transport API (transport -> core)
  TransportCallbackRequest: {
    schema: transportCallbackRequestSchema,
    io: "input",
    note: "POST /api/internal/transports/callback — a feedback-menu button was pressed.",
  },
  TransportCallbackResponse: {
    schema: transportCallbackResponseSchema,
    io: "output",
    note: "The toast to answer the platform's callback query with, or null.",
  },
  TransportMessageLookupResponse: {
    schema: transportMessageLookupResponseSchema,
    io: "output",
    note: "GET /api/internal/transports/messages — does the target message exist in the core's mirror, and is it the assistant's own?",
  },
};

/** JSON Schema for one shape, with its note carried into the document. */
function jsonSchemaOf(name: string, shape: Named): Record<string, unknown> {
  const schema = z.toJSONSchema(shape.schema, {
    io: shape.io,
    // Nothing here uses a type JSON Schema cannot express; if that ever
    // changes, the generator should fail loudly rather than emit `{}`.
    unrepresentable: "throw",
    target: "draft-2020-12",
  }) as Record<string, unknown>;
  const { $schema: _dropped, ...rest } = schema;
  return { title: name, description: shape.note, ...rest };
}

function eventsDocument(): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const name of Object.keys(SHAPES).sort()) {
    defs[name] = jsonSchemaOf(name, SHAPES[name]);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${REPO}/blob/main/docs/api/transport/events.schema.json`,
    title: "assistant-hub-swarm transport wire contract",
    description:
      "Every shape that crosses the boundary between an assistant-hub-swarm core and a " +
      "transport, in both directions. GENERATED from the zod schemas of " +
      "@assistant-hub-swarm/transport-sdk — do not edit by hand; run " +
      "`npm run wire:generate -w @assistant-hub-swarm/transport-sdk`. " +
      `The manual is at ${MANUAL}.`,
    "x-contract-major": CONTRACT_MAJOR,
    "x-redis": {
      updatesQueue: TRANSPORT_UPDATES_QUEUE,
      eventsChannel: BUS_EVENTS_CHANNEL,
    },
    $defs: defs,
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const TOKEN_HEADER_NOTE =
  "Authenticated by the shared `INTERNAL_API_TOKEN` in the `x-internal-token` header — the same secret in both directions.";

/** A JSON request body. */
function body(name: string) {
  return { required: true, content: { "application/json": { schema: ref(name) } } };
}

/** A 200 with a bare JSON object (no `data` envelope on this surface). */
function ok(description: string, name?: string) {
  return {
    "200": {
      description,
      ...(name ? { content: { "application/json": { schema: ref(name) } } } : {}),
    },
  };
}

const ERRORS = {
  "400": { description: "The body or a parameter did not match the schema.", content: { "application/json": { schema: ref("InternalError") } } },
  "401": { description: "Missing or wrong internal token.", content: { "application/json": { schema: ref("InternalError") } } },
};

/** The platform refused the action; its own words are relayed. */
const PLATFORM_REFUSED = {
  "502": {
    description: "The platform refused the action. The body carries the platform's own words, which the core relays to whoever asked.",
    content: { "application/json": { schema: ref("InternalError") } },
  },
};

const CHAT_PARAM = {
  name: "chatId",
  in: "path",
  required: true,
  description: "The conversation's source-local id, verbatim.",
  schema: { type: "string" },
};

const MESSAGE_PARAM = {
  name: "messageId",
  in: "path",
  required: true,
  description: "The message's source-local id, verbatim.",
  schema: { type: "string" },
};

const ASSISTANT_QUERY = {
  name: "assistantId",
  in: "query",
  required: false,
  description: "Whose connection performs the send. Absent: whichever connection runs.",
  schema: { type: "string" },
};

function openapiDocument(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    InternalError: {
      title: "InternalError",
      description: "The reduced error shape of both internal surfaces: a message, no envelope.",
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["message"],
          properties: { message: { type: "string" } },
        },
      },
    },
    ConfigBlob: {
      title: "ConfigBlob",
      description: "An opaque JSON object of a transport's own keys. The core stores and hands it back; it never reads inside.",
      type: "object",
      additionalProperties: true,
    },
    HealthResponse: {
      title: "HealthResponse",
      description: "What a transport answers on /health — probed unauthenticated by the core on every assistant-editor read and by the Overview status card.",
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        connections: {
          type: "array",
          items: {
            type: "object",
            required: ["connectionId", "state"],
            properties: {
              connectionId: { type: "string" },
              assistantId: { type: ["string", "null"] },
              state: { type: "string", description: "`starting` | `running` | `stopped` | `error` — what the dashboard shows." },
              username: { type: ["string", "null"] },
              since: { type: ["string", "null"], format: "date-time" },
              error: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  };
  for (const name of Object.keys(SHAPES).sort()) {
    schemas[name] = jsonSchemaOf(name, SHAPES[name]);
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "assistant-hub-swarm transport HTTP contract",
      version: `contract-major-${CONTRACT_MAJOR}`,
      description: [
        "The HTTP that crosses the boundary between an assistant-hub-swarm core and a transport,",
        "in both directions. Two servers are described:",
        "",
        "- **A transport's own surface** (`/health`, `/internal/*`, `/mcp`) — what the core",
        "  calls on you. Implement it.",
        "- **The core's transport API** (`/api/internal/transports/*`) — what you call on the",
        "  core: registration, desired state, the callback answer, the mirror lookup and the",
        "  config write-back.",
        "",
        "Everything else is asynchronous, over Redis: see `events.schema.json`.",
        "",
        "GENERATED from the zod schemas of `@assistant-hub-swarm/transport-sdk` — do not edit",
        "by hand; run `npm run wire:generate -w @assistant-hub-swarm/transport-sdk`.",
        `The manual is at ${MANUAL}.`,
      ].join("\n"),
    },
    servers: [
      { url: "http://transport:3220", description: "A transport, at the base URL it announced (SELF_URL)." },
      { url: "http://core:3200", description: "The core (CORE_API_URL)." },
    ],
    tags: [
      { name: "transport", description: `Served BY a transport, called by the core. ${TOKEN_HEADER_NOTE}` },
      { name: "core", description: `Served BY the core, called by a transport. ${TOKEN_HEADER_NOTE}` },
    ],
    security: [{ internalToken: [] }],
    paths: {
      "/health": {
        get: {
          tags: ["transport"],
          summary: "Is the transport up, and what is running",
          description:
            "The one open route: it carries no secrets and the core probes it unauthenticated, " +
            "with a 5 s timeout. Answer from the first moment of boot — before registering — " +
            "so a starting transport shows as starting rather than as absent.",
          security: [],
          responses: ok("Per-connection state, as the dashboard shows it.", "HealthResponse"),
        },
      },
      "/internal/chats/{chatId}/messages": {
        parameters: [CHAT_PARAM],
        post: {
          tags: ["transport"],
          summary: "Send a message and answer with its id",
          description:
            "The sends that need the delivered id back: a silent browsing acknowledgement " +
            "(registered for later deletion) and a self-link confirmation. Ordinary replies " +
            "arrive as `reply.delivery` on the bus instead. Report this send as " +
            "`message.delivered` like any other.",
          parameters: [ASSISTANT_QUERY],
          requestBody: body("InternalSendMessageRequest"),
          responses: { ...ok("The delivered message.", "InternalSentMessageResponse"), ...ERRORS, ...PLATFORM_REFUSED },
        },
      },
      "/internal/chats/{chatId}/messages/{messageId}": {
        parameters: [CHAT_PARAM, MESSAGE_PARAM],
        delete: {
          tags: ["transport"],
          summary: "Delete one of the assistant's own messages",
          description:
            "Removing a stale acknowledgement or menu. A platform that refuses (Telegram will " +
            "not delete messages older than 48 h) answers `deleted: false` — never an error, " +
            "because the message simply staying is cosmetic for every caller.",
          responses: { ...ok("Whether the platform performed it.", "InternalDeleteMessageResponse"), ...ERRORS },
        },
      },
      "/internal/chats/{chatId}/voice": {
        parameters: [CHAT_PARAM],
        post: {
          tags: ["transport"],
          summary: "Deliver a reply as a voice message",
          description:
            "The speech is synthesized in the core; the bytes cross here. Fall back to a text " +
            "send of `text` when the platform refuses the voice form, and say so with " +
            "`asVoice: false` — the core mirrors the words either way.",
          requestBody: body("InternalSendVoiceRequest"),
          responses: { ...ok("What was actually delivered.", "InternalSentVoiceResponse"), ...ERRORS, ...PLATFORM_REFUSED },
        },
      },
      "/internal/chats/{chatId}/photos": {
        parameters: [CHAT_PARAM],
        post: {
          tags: ["transport"],
          summary: "Deliver generated images",
          description:
            "Images a tool drew during the turn, delivered after the reply. Report each with " +
            "`message.delivered` carrying its media, so the core's describer reads what the " +
            "assistant itself put in the chat.",
          requestBody: body("InternalSendPhotosRequest"),
          responses: { ...ok("One entry per image, in order.", "InternalSentPhotosResponse"), ...ERRORS, ...PLATFORM_REFUSED },
        },
      },
      "/internal/chats/{chatId}/files": {
        parameters: [CHAT_PARAM],
        post: {
          tags: ["transport"],
          summary: "Deliver a file",
          description:
            "A browser-agent download. Pick the playable send kind by mime where the platform " +
            "has one, and retry as a plain attachment when it refuses the container. The core " +
            "allows 500 s for this call, because the upload is the platform's.",
          requestBody: body("InternalSendFileRequest"),
          responses: { ...ok("The delivered file message.", "InternalSentFileResponse"), ...ERRORS, ...PLATFORM_REFUSED },
        },
      },
      "/internal/chats/{chatId}/menu": {
        parameters: [CHAT_PARAM],
        post: {
          tags: ["transport"],
          summary: "Post a button menu",
          description:
            "The feedback flow's options menu. The grid is plain data; render it however the " +
            "platform allows. A platform with no buttons never receives this call, because it " +
            "never publishes `transport.reaction` — the contract carries no capability flags.",
          parameters: [ASSISTANT_QUERY],
          requestBody: body("InternalSendMenuRequest"),
          responses: { ...ok("The posted menu.", "InternalSentMenuResponse"), ...ERRORS, ...PLATFORM_REFUSED },
        },
      },
      "/internal/chats/{chatId}/menu/{messageId}": {
        parameters: [CHAT_PARAM, MESSAGE_PARAM],
        patch: {
          tags: ["transport"],
          summary: "Rewrite a posted menu",
          description: "`keyboard: null` removes the buttons and leaves the text.",
          parameters: [ASSISTANT_QUERY],
          requestBody: body("InternalEditMenuRequest"),
          responses: { ...ok("Acknowledged."), ...ERRORS, ...PLATFORM_REFUSED },
        },
        delete: {
          tags: ["transport"],
          summary: "Remove a posted menu",
          parameters: [ASSISTANT_QUERY],
          responses: { ...ok("Whether the platform performed it.", "InternalDeleteMessageResponse"), ...ERRORS },
        },
      },
      "/internal/chats/{chatId}/title": {
        parameters: [CHAT_PARAM],
        put: {
          tags: ["transport"],
          summary: "Name a conversation",
          description:
            "Only for platforms whose conversations arrive unnamed, which is what " +
            "`chatInfo.titleProvisional` says. A platform whose chats have real names of their " +
            "own does not serve this route at all.",
          requestBody: body("InternalSetTitleRequest"),
          responses: { ...ok("The title it now carries.", "InternalSetTitleResponse"), ...ERRORS, ...PLATFORM_REFUSED },
        },
      },
      "/mcp": {
        post: {
          tags: ["transport"],
          summary: "The transport's own MCP server",
          description:
            "MCP over Streamable HTTP, at the `mcpPath` announced at registration. Stateless: " +
            "one server per request, no session ids — every call carries its whole turn in " +
            "`_meta` (see `TurnToolMeta`), so nothing is worth keeping alive between calls and " +
            "nothing needs reconciling after a restart. The core provisions the tool " +
            "connection itself; the tools reach the model as `<source>__<tool>`, on this " +
            "platform's turns only.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", additionalProperties: true, description: "A JSON-RPC message of the Model Context Protocol." } } },
          },
          responses: {
            "200": {
              description: "A JSON-RPC response, or an SSE stream.",
              content: {
                "application/json": { schema: { type: "object", additionalProperties: true } },
                "text/event-stream": { schema: { type: "string" } },
              },
            },
            ...ERRORS,
          },
        },
      },
      "/api/internal/transports/register": {
        post: {
          tags: ["core"],
          summary: "Register, and receive the desired state",
          description:
            "A transport announces itself at boot; the answer IS its desired state, so " +
            "registration doubles as the first fetch. Retry until the core answers — it may " +
            "boot second. The id is accepted on shape alone: there is no list in the core to " +
            "extend. Re-registering is how a transport reports a new build; the operator's " +
            "`enabled` flag and stored config blobs survive it.",
          requestBody: body("TransportRegistrationRequest"),
          responses: {
            ...ok("The desired state to reconcile against.", "TransportDesiredState"),
            ...ERRORS,
            "409": {
              description:
                "The announced `contractMajor` is not the one this core speaks. The message " +
                "names both. The registration row is kept so the dashboard shows the refusal " +
                "next to the transport's name; no desired state is given, and its events are " +
                "dropped at ingest until one side is updated.",
              content: { "application/json": { schema: ref("InternalError") } },
            },
          },
        },
      },
      "/api/internal/transports/{id}/desired": {
        parameters: [
          { name: "id", in: "path", required: true, description: "The transport's own id.", schema: ref("SourceId") },
        ],
        get: {
          tags: ["core"],
          summary: "Refetch the desired state",
          description:
            "Called on every `transport.config.changed` (and `assistant.deleted`) for this " +
            "transport. A connection's `enabled` already folds in the transport-level switch " +
            "and the owning account's deactivation, so reconciling to this answer is the whole " +
            "decision.",
          responses: { ...ok("The desired state.", "TransportDesiredState"), ...ERRORS, "404": { description: "No transport with that id is registered.", content: { "application/json": { schema: ref("InternalError") } } } },
        },
      },
      "/api/internal/transports/{id}/config": {
        parameters: [
          { name: "id", in: "path", required: true, description: "The transport's own id.", schema: ref("SourceId") },
        ],
        patch: {
          tags: ["core"],
          summary: "Write back into the transport-level config",
          description:
            "For something the transport resolved and wants kept across restarts. Shallow " +
            "merge; the keys are the transport's own and the core never reads inside them.",
          requestBody: body("ConfigBlob"),
          responses: {
            "200": {
              description: "The transport-level blob after the merge.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["config"],
                    properties: { config: ref("ConfigBlob") },
                  },
                },
              },
            },
            ...ERRORS,
            "404": { description: "No transport with that id is registered.", content: { "application/json": { schema: ref("InternalError") } } },
          },
        },
      },
      "/api/internal/transports/messages": {
        get: {
          tags: ["core"],
          summary: "Ask the mirror about one message",
          description:
            "What a reaction tool checks before touching the platform: does the target exist, " +
            "and is it the assistant's own? A guessed id is then refused without a platform " +
            "call. `assistantId` with `direct=true` picks that assistant's direct stream; a " +
            "group chat is one shared stream.",
          parameters: [
            { name: "source", in: "query", required: true, schema: ref("SourceId") },
            { name: "chatId", in: "query", required: true, schema: { type: "string" } },
            { name: "sourceMessageId", in: "query", required: true, schema: { type: "string" } },
            { name: "assistantId", in: "query", required: false, schema: { type: "string" } },
            {
              name: "direct",
              in: "query",
              required: false,
              description: "Literal `true` selects the assistant's own direct stream.",
              schema: { type: "string", enum: ["true", "false"] },
            },
          ],
          responses: { ...ok("What the mirror holds.", "TransportMessageLookupResponse"), ...ERRORS },
        },
      },
      "/api/internal/transports/callback": {
        post: {
          tags: ["core"],
          summary: "A feedback-menu button was pressed",
          description:
            "The one update that is request/response rather than a queue event: the platform's " +
            "button spinner wants a toast only the flow's outcome can word. Never a 5xx — a " +
            "platform with no feedback flow, or a flow that failed, gets `toast: null`.",
          requestBody: body("TransportCallbackRequest"),
          responses: { ...ok("The toast to answer with, or null.", "TransportCallbackResponse"), ...ERRORS },
        },
      },
    },
    components: {
      securitySchemes: {
        internalToken: {
          type: "apiKey",
          in: "header",
          name: "x-internal-token",
          description: TOKEN_HEADER_NOTE,
        },
      },
      schemas,
    },
  };
}

/** The two files, as they must appear on disk. */
export function wireContractFiles(): { path: string; content: string }[] {
  return [
    {
      path: join(OUT_DIR, "events.schema.json"),
      content: `${JSON.stringify(eventsDocument(), null, 2)}\n`,
    },
    {
      path: join(OUT_DIR, "openapi.yaml"),
      // `aliasDuplicateObjects: false`: the document reuses the same parameter
      // and error objects across routes, and YAML would otherwise emit them as
      // anchors and `*aliases` — valid YAML that plenty of OpenAPI tooling
      // mishandles, and that nobody wants to read.
      content: stringify(openapiDocument(), {
        lineWidth: 0,
        singleQuote: false,
        aliasDuplicateObjects: false,
      }),
    },
  ];
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const file of wireContractFiles()) {
    writeFileSync(file.path, file.content, "utf8");
    console.log(`wrote ${file.path}`);
  }
}

// Running this file writes; importing it (the drift check) only borrows
// `wireContractFiles`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
