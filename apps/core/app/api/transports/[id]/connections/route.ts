import { sourceIdSchema } from "@assistant-hub/contracts";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";
import { isRestricted, requireAssistantOwnership } from "@/server/ownership";
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

// Account level since Phase 9, gated per assistant: a user-role account
// connects and manages bots on its OWN assistants only (full parity).
export const GET = defineRoute(
  async ({ request, params, account }) => {
    const transport = transportOf(params);
    const assistantId = new URL(request.url).searchParams.get("assistantId") ?? undefined;
    if (isRestricted(account)) {
      // The section is per assistant in the editor; a scoped caller must say
      // whose, and it must be theirs.
      if (!assistantId) throw ApiError.badRequest("assistantId is required");
      await requireAssistantOwnership(account, assistantId);
    }
    return ok({ connections: await listConnectionViews(transport, assistantId) });
  },
  { access: "account" },
);

export const POST = defineRoute(
  async ({ request, params, account }) => {
    const transport = transportOf(params);
    const input = await parseJson(request, createSchema);
    await requireAssistantOwnership(account, input.assistantId);
    const row = await createAssistantTransport(
      { transport, assistantId: input.assistantId, config: input.config },
      { kind: "dashboard" },
    );
    const views = await listConnectionViews(transport, row.assistantId);
    return ok({ connection: views.find((view) => view.id === row.id) ?? null }, { status: 201 });
  },
  { access: "account" },
);
