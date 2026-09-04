import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

import { scopedRef } from "@assistant-hub-swarm/contracts";
import { and, eq, gt, isNull, lt } from "drizzle-orm";

import {
  findLinksForRefs,
  insertPersonLink,
  listMembersOfLinks,
  replacePersonLinkMembers,
} from "@/features/person-links/server/repository";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { getAccountById } from "@/server/auth/accounts";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
import { withTrace } from "@/server/trace";

import { accountLinkCodes } from "../../../store/schema";

/**
 * The self-link flow (Phase 8, PLAN.md "Identity links"): a signed-in
 * account mints a one-time code in its profile and sends it to any
 * connected bot; the core's ingest recognizes the message, joins that
 * platform identity to the account in the person-link graph, and confirms
 * in the chat. Admins link/unlink manually on the users page — this is the
 * self-service path.
 */

const FEATURE = FEATURES.accounts;

/** How long a minted code stays redeemable. */
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/** What a code looks like — cheap mechanical gate before any DB read. */
const CODE_PATTERN = /^link-[a-z0-9]{8}$/;

/**
 * A leading `@handle` — how every platform spells "this message is for you".
 * Not linguistic: one token, at the front, beginning with `@`.
 */
const ADDRESSING_PREFIX = /^(?:@[^\s@]+\s+)+/;

/**
 * The message with its addressing stripped.
 *
 * A code has to be the WHOLE message, and on a platform where addressing a bot
 * in a shared channel REQUIRES mentioning it, that is unreachable — the code is
 * never alone (user decision, 2026-09-04, after `@bot link-xxxxxxxx` fell
 * through to the model on Discord). Telegram groups have had the same problem
 * since the beginning.
 *
 * Only the addressing comes off, so the property that made the anchor worth
 * having survives: a code quoted inside a sentence still does not redeem,
 * because what is left has to be nothing but the code.
 */
export function withoutAddressing(text: string): string {
  return text.replace(ADDRESSING_PREFIX, "").trim();
}

/** Unambiguous alphabet (no 0/o, 1/l) for hand-typed codes. */
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function newCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `link-${out}`;
}

/**
 * Mint a fresh code for the acting account. Unused earlier codes are
 * retired — one live code per account, so a leaked older one is dead the
 * moment a new one exists. The code itself never reaches the trace.
 */
export async function mintLinkCode(
  accountId: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  return withTrace(
    { feature: FEATURE.id, action: "mint-link-code", trigger, inputSummary: "self-link code" },
    async (trace) => {
      await db
        .delete(accountLinkCodes)
        .where(and(eq(accountLinkCodes.accountId, accountId), isNull(accountLinkCodes.usedAt)));
      const code = newCode();
      const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
      await db.insert(accountLinkCodes).values({ code, accountId, expiresAt });
      await trace.succeed({
        outputSummary: "one-time code minted (15 min)",
        relatedIds: { [FEATURE.relatedIdsKey]: [accountId] },
      });
      return { code, expiresAt: expiresAt.toISOString() };
    },
  );
}

/** What redeeming a code in a chat came to. */
export type SelfLinkOutcome =
  | { status: "linked"; accountLabel: string }
  | { status: "already-linked"; accountLabel: string }
  | { status: "conflict" }
  | { status: "invalid" };

/**
 * Try to redeem `text` as a self-link code from `senderRef` (a platform
 * identity). Returns null unless the message IS a code-shaped string — the
 * caller then treats the message as consumed, whatever the outcome. On
 * success the identity joins the account's link group and the code burns.
 */
export async function redeemLinkCode(
  input: { senderRef: string; text: string },
  db: StoreDb = getStoreDb(),
  now: Date = new Date(),
): Promise<SelfLinkOutcome | null> {
  const candidate = withoutAddressing(input.text.trim()).toLowerCase();
  if (!CODE_PATTERN.test(candidate)) return null;

  return withTrace(
    {
      feature: FEATURE.id,
      action: "self-link",
      trigger: { kind: "transport", actor: input.senderRef },
      inputSummary: `code from ${input.senderRef}`,
    },
    async (trace): Promise<SelfLinkOutcome> => {
      const rows = await db
        .select()
        .from(accountLinkCodes)
        .where(
          and(
            eq(accountLinkCodes.code, candidate),
            isNull(accountLinkCodes.usedAt),
            gt(accountLinkCodes.expiresAt, now),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        await trace.succeed({ outputSummary: "code invalid or expired" });
        return { status: "invalid" };
      }
      const account = await getAccountById(row.accountId, db);
      if (!account || !account.active) {
        await trace.succeed({ outputSummary: "code's account is gone or deactivated" });
        return { status: "invalid" };
      }
      const accountRef = scopedRef("chat", "user", account.id);
      const accountLabel = account.displayName ?? account.username;

      const linkOf = await findLinksForRefs(db, [input.senderRef, accountRef]);
      const senderLink = linkOf.get(input.senderRef) ?? null;
      const accountLink = linkOf.get(accountRef) ?? null;

      const burn = () =>
        db
          .update(accountLinkCodes)
          .set({ usedAt: now })
          .where(eq(accountLinkCodes.code, candidate));

      if (senderLink && accountLink && senderLink === accountLink) {
        await burn();
        await trace.succeed({ outputSummary: `already linked to '${account.username}'` });
        return { status: "already-linked", accountLabel };
      }
      if (senderLink && accountLink) {
        // Two different persons would have to merge — that is an admin call
        // on the users page, not something a chat message may decide.
        await trace.succeed({ outputSummary: "both identities already belong to different links" });
        return { status: "conflict" };
      }

      if (senderLink || accountLink) {
        const linkId = (senderLink ?? accountLink)!;
        const members = (await listMembersOfLinks(db, [linkId])).get(linkId) ?? [];
        // A person carries at most one account: a sender whose link already
        // holds a DIFFERENT account's web ref is somebody else's identity.
        const otherAccount = members.some(
          (member) => member !== accountRef && member.startsWith("chat:user:"),
        );
        if (senderLink && otherAccount) {
          await trace.succeed({ outputSummary: "sender already belongs to another account" });
          return { status: "conflict" };
        }
        const added = senderLink ? accountRef : input.senderRef;
        await replacePersonLinkMembers(db, linkId, [...members, added]);
      } else {
        await insertPersonLink(db, {
          id: randomUUID(),
          note: null,
          members: [input.senderRef, accountRef],
        });
      }
      await burn();
      publishEvent("users");
      publishEvent(FEATURE.realtimeTopic);
      await trace.succeed({
        outputSummary: `${input.senderRef} linked to '${account.username}'`,
        relatedIds: { [FEATURE.relatedIdsKey]: [account.id] },
      });
      return { status: "linked", accountLabel };
    },
  );
}

/** The chat-facing wording for each outcome (the ingest sends it verbatim). */
export function selfLinkReplyText(outcome: SelfLinkOutcome): string {
  switch (outcome.status) {
    case "linked":
      return `Done — this chat identity is now linked to ${outcome.accountLabel}. Memory and permissions follow you here from now on.`;
    case "already-linked":
      return `You are already linked to ${outcome.accountLabel} — nothing to do.`;
    case "conflict":
      return "This identity already belongs to a different linked person. Ask an admin to sort the links out on the dashboard.";
    case "invalid":
      return "That link code is invalid or has expired. Mint a fresh one in your profile and send it within 15 minutes.";
  }
}

/** Test/maintenance helper: purge expired unused codes. */
export async function pruneExpiredLinkCodes(
  db: StoreDb = getStoreDb(),
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .delete(accountLinkCodes)
    .where(and(isNull(accountLinkCodes.usedAt), lt(accountLinkCodes.expiresAt, now)))
    .returning({ code: accountLinkCodes.code });
  return rows.length;
}
