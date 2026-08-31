import { createAssistantSchema } from "@/features/assistants/server/schema";
import { createAssistant, getAssistants } from "@/features/assistants/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";
import { isRestricted } from "@/server/ownership";

/**
 * Assistants collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording. Account level since Phase 9: any
 * account creates its own assistants (full parity); a user-role account
 * sees only its own — everywhere, the web chat's new-thread picker
 * included.
 */
export const GET = defineRoute(
  async ({ account }) => {
    const all = await getAssistants();
    const visible = isRestricted(account)
      ? all.filter((assistant) => assistant.ownerAccountId === account.id)
      : all;
    return ok({ assistants: visible });
  },
  { access: "account" },
);

export const POST = defineRoute(
  async ({ request, account }) => {
    const input = await parseJson(request, createAssistantSchema);
    // The creator owns the assistant (Phase 8 owner rights).
    return ok(await createAssistant(input, { kind: "dashboard" }, account), { status: 201 });
  },
  { access: "account" },
);
