import { mintLinkCode } from "@/features/accounts/server/self-link";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok } from "@/server/http";

/**
 * Mint a one-time self-link code for the acting account (Phase 8): send it
 * to any connected bot within 15 minutes and that platform identity links
 * to this account. Minting again retires the previous unused code.
 */
export const POST = defineRoute(
  async ({ account }) => {
    if (!account) throw ApiError.unauthorized("Sign in to mint a link code");
    return ok(await mintLinkCode(account.id, { kind: "dashboard" }));
  },
  { access: "account" },
);
