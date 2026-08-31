import { updateToolConnectionSchema } from "@/features/tool-connections/server/schema";
import {
  editToolConnection,
  removeToolConnection,
} from "@/features/tool-connections/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-connection API. Thin handlers: the service owns validation, the
 * managed-connection rules, ownership gating (Phase 9), persistence and
 * trace recording.
 */
export const PATCH = defineRoute(
  async ({ request, params, account }) => {
    const input = await parseJson(request, updateToolConnectionSchema);
    return ok(await editToolConnection(params.id, input, { kind: "dashboard" }, account));
  },
  { access: "account" },
);

export const DELETE = defineRoute(
  async ({ params, account }) => {
    await removeToolConnection(params.id, { kind: "dashboard" }, account);
    return ok({ deleted: true });
  },
  { access: "account" },
);
