import { sourceIdSchema } from "@assistant-hub/contracts";
import { z } from "zod";

/**
 * Tool-connections validation contract — the shape of an MCP tool connection
 * and of its create/update inputs. Shared by the service, Route Handlers and
 * the dashboard (PLAN.md, "MCP tool connections").
 *
 * A connection is a remote MCP server the operator adds; its tools are
 * offered to the model under the connection's slug prefix, along the three
 * scope dimensions decided 2026-08-28: global, one source app, and either
 * every assistant or an explicit selection.
 */

export const MAX_CONNECTIONS = 32;
export const MAX_NAME_LEN = 64;
export const MAX_SLUG_LEN = 24;
export const MAX_HEADERS = 8;
export const MAX_HEADER_VALUE_LEN = 2_000;

/**
 * The slug is the model-visible tool prefix (`<slug>__<tool>`), so it is
 * restricted to what an OpenAI-compatible tool name accepts, and to a shape
 * that cannot itself contain the separator.
 */
export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug is required")
  .max(MAX_SLUG_LEN)
  .regex(SLUG_PATTERN, "Use lowercase letters, digits and dashes, starting with a letter");

const name = z.string().trim().min(1, "Name is required").max(MAX_NAME_LEN);

/**
 * Only `http` is executed in v2; `stdio` is modeled so the discriminator and
 * UI need no rework when it lands, and the service refuses it.
 */
export const TOOL_TRANSPORTS = ["http", "stdio"] as const;
export const transportSchema = z.enum(TOOL_TRANSPORTS);
export type ToolTransport = z.infer<typeof transportSchema>;

const endpointUrl = z
  .string()
  .trim()
  .min(1, "Endpoint URL is required")
  .url("Enter a valid URL")
  .refine((value) => /^https?:/i.test(value), "Only http(s) endpoints are supported");

/**
 * Auth headers as `{ name: value }`. Header names follow the HTTP token
 * grammar so a malformed one fails here rather than inside `fetch`.
 */
const authHeaders = z
  .record(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Invalid header name"),
    z.string().max(MAX_HEADER_VALUE_LEN),
  )
  .refine((headers) => Object.keys(headers).length <= MAX_HEADERS, {
    message: `At most ${MAX_HEADERS} headers`,
  });

/** One tool as stored in the applied snapshot. */
export const connectionToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  appliedAt: z.string().datetime(),
});

export type ConnectionTool = z.infer<typeof connectionToolSchema>;

/** A tool as the last discovery saw it (not necessarily applied). */
export const discoveredToolSchema = connectionToolSchema.omit({ appliedAt: true });

export type DiscoveredToolView = z.infer<typeof discoveredToolSchema>;

/** What a discovery found against what is applied, by tool name. */
export const toolsetDiffSchema = z.object({
  added: z.array(z.string()),
  changed: z.array(z.string()),
  removed: z.array(z.string()),
  unchanged: z.array(z.string()),
});

/**
 * A connection as returned to clients. Header VALUES never leave the server
 * (the `backends.api_key` precedent); the operator sees which headers are
 * set, not what they are.
 */
export const toolConnectionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  transport: transportSchema,
  endpointUrl: z.string(),
  /** Names of the configured auth headers, values withheld. */
  authHeaderNames: z.array(z.string()),
  enabled: z.boolean(),
  /** Null = every source app; else the only source whose turns may call it. */
  appScope: sourceIdSchema.nullable(),
  allAssistants: z.boolean(),
  /** Assistant ids allowed to call it when `allAssistants` is false. */
  assistantIds: z.array(z.string()),
  managed: z.boolean(),
  lastDiscoveredAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  /** What the last discovery saw, or null before the first one. */
  discoveredTools: z.array(discoveredToolSchema).nullable(),
  /** That discovery against the applied snapshot; null before the first one. */
  drift: toolsetDiffSchema.nullable(),
  /** The applied snapshot — exactly the tools the model is offered. */
  tools: z.array(connectionToolSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ToolConnection = z.infer<typeof toolConnectionSchema>;

/** Create input. Everything but slug/name/endpoint has a sensible default. */
export const createToolConnectionSchema = z.object({
  slug,
  name,
  transport: transportSchema.optional().default("http"),
  endpointUrl,
  authHeaders: authHeaders.optional().default({}),
  enabled: z.boolean().optional().default(true),
  appScope: sourceIdSchema.nullable().optional().default(null),
  allAssistants: z.boolean().optional().default(true),
  assistantIds: z.array(z.string()).optional().default([]),
});

export type CreateToolConnection = z.infer<typeof createToolConnectionSchema>;

/**
 * Update input: any subset of the editable fields, at least one present.
 * Sending `authHeaders` replaces the whole set — a partial merge would make
 * removing a header impossible without a second field.
 */
export const updateToolConnectionSchema = z
  .object({
    slug,
    name,
    endpointUrl,
    authHeaders,
    enabled: z.boolean(),
    appScope: sourceIdSchema.nullable(),
    allAssistants: z.boolean(),
    assistantIds: z.array(z.string()),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateToolConnection = z.infer<typeof updateToolConnectionSchema>;

/**
 * The model-visible name of a connection's tool. Built-in feature tools keep
 * their bare names — renaming them would invalidate stored traces, task rows
 * and the prompt text that names them — so the prefix exists only to stop
 * two connections colliding.
 */
export function prefixedToolName(connectionSlug: string, toolName: string): string {
  return `${connectionSlug}__${toolName}`;
}

/** Split a prefixed tool name back into slug and remote tool name. */
export function parsePrefixedToolName(
  prefixed: string,
): { slug: string; tool: string } | null {
  const at = prefixed.indexOf("__");
  if (at <= 0) return null;
  const slugPart = prefixed.slice(0, at);
  const tool = prefixed.slice(at + 2);
  if (!tool || !SLUG_PATTERN.test(slugPart)) return null;
  return { slug: slugPart, tool };
}
