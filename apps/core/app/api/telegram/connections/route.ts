import { z } from "zod";

import { defineRoute, ok, parseJson, parseQuery } from "@/server/http";
import {
  createSourceConnection,
  listSourceConnections,
} from "@/server/source/tg-operator";

/**
 * Telegram connections proxy: the dashboard surface over the tg source app's
 * operator connections API (the assistant editor's tg section and the
 * Overview's per-connection controls both talk here). Thin by design — the
 * source owns validation of its own store; this layer adds only the operator
 * session and relays the source's verdicts (409 one-bot-per-assistant, …).
 */

const listQuerySchema = z.object({ assistantId: z.string().min(1).optional() });

const createSchema = z.object({
  assistantId: z.string().min(1),
  botToken: z.string().trim().min(1).max(200),
});

export const GET = defineRoute(async ({ request }) => {
  const { assistantId } = parseQuery(request, listQuerySchema);
  return ok({ connections: await listSourceConnections(assistantId) });
});

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createSchema);
  return ok({ connection: await createSourceConnection(input) });
});
