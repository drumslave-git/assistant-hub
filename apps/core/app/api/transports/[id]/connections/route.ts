import { sourceIdSchema } from "@assistant-hub/contracts";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";
import {
  createAssistantTransport,
  listConnectionViews,
} from "@/server/transports/service";

/** One transport's per-assistant connections (the assistant editor's section). */

const createSchema = z.object({
  assistantId: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
});

function transportOf(params: Record<string, string>): ReturnType<typeof sourceIdSchema.parse> {
  const parsed = sourceIdSchema.safeParse(params.id);
  if (!parsed.success) throw ApiError.badRequest("unknown transport");
  return parsed.data;
}

export const GET = defineRoute(async ({ request, params }) => {
  const transport = transportOf(params);
  const assistantId = new URL(request.url).searchParams.get("assistantId") ?? undefined;
  return ok({ connections: await listConnectionViews(transport, assistantId) });
});

export const POST = defineRoute(async ({ request, params }) => {
  const transport = transportOf(params);
  const input = await parseJson(request, createSchema);
  const row = await createAssistantTransport(
    { transport, assistantId: input.assistantId, config: input.config },
    { kind: "dashboard" },
  );
  const views = await listConnectionViews(transport, row.assistantId);
  return ok({ connection: views.find((view) => view.id === row.id) ?? null }, { status: 201 });
});
