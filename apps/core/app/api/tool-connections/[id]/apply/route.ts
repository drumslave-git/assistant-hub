import { applyToolConnection } from "@/features/tool-connections/server/discovery";
import { defineRoute, ok } from "@/server/http";

/**
 * Make the reviewed discovery the offered toolset — the only write that
 * changes what the model can call. Ownership-gated (Phase 9).
 */
export const POST = defineRoute(
  async ({ params, account }) =>
    ok(await applyToolConnection(params.id, { kind: "dashboard" }, account)),
  { access: "account" },
);
