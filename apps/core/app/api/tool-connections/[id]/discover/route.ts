import { discoverToolConnection } from "@/features/tool-connections/server/discovery";
import { defineRoute, ok } from "@/server/http";

/**
 * Ask one connection's server what it offers. A server that cannot be
 * reached is a report with `ok: false`, not a 5xx: the operator asked a
 * question and got an answer, and the applied toolset is untouched either
 * way. Ownership-gated (Phase 9).
 */
export const POST = defineRoute(
  async ({ params, account }) =>
    ok(await discoverToolConnection(params.id, { kind: "dashboard" }, account)),
  { access: "account" },
);
