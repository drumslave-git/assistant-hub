import { applyToolConnection } from "@/features/tool-connections/server/discovery";
import { defineRoute, ok } from "@/server/http";

/**
 * Make the reviewed discovery the offered toolset — the only write that
 * changes what the model can call.
 */
export const POST = defineRoute(async ({ params }) =>
  ok(await applyToolConnection(params.id, { kind: "dashboard" })),
);
