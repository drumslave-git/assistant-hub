import "server-only";

import { parseScopedRef, type InboundMessageEvent } from "@assistant-hub/contracts";
import { eq } from "drizzle-orm";

import { getDb } from "@/db/drizzle";
import { knownGroups, knownUsers } from "@/db/schema";
import { rememberGroupActivity } from "@/features/known-groups/server/service";
import { recordGroupMembership } from "@/features/known-groups/server/repository";
import { rememberUser } from "@/features/known-users/server/service";

/**
 * TRANSITIONAL (dies at the Phase 6 cutover): mirror each inbound event's
 * identity into the v1 directory tables.
 *
 * The v1 brain still runs on the v1 database, whose tables FK `known_users`
 * (preferences, memory docs, exclusions) and whose label/roster readers
 * (task-fire chat context, analytics, memory pages, the alias tool's
 * chat-scoped resolution) read `known_users` / `known_groups` /
 * `group_members`. Since the source split nothing else populates them — the
 * source owns the real directory — so the consumer refreshes this shadow
 * from what every event already carries. Operator-curated fields (aliases,
 * language, notes) are refreshed too: their authority is the source (edits
 * write there first), and the shadow follows.
 *
 * Best-effort by design, like the v1 capture path: a directory hiccup must
 * never cost a turn.
 */
export async function shadowDirectory(
  event: InboundMessageEvent,
  options?: {
    /**
     * Skip the sender half: the message was cross-fed from another assistant,
     * so its "sender" is a bot account. The directory is of people — a bot
     * belongs in it no more than it belongs in someone's memory.
     */
    skipSender?: boolean;
  },
): Promise<void> {
  try {
    const db = getDb();
    const chatId = parseScopedRef(event.chat.ref).id;
    const senderId = parseScopedRef(event.sender.ref).id;
    const shadowSender = !options?.skipSender;

    if (shadowSender) {
      await rememberUser({
        userId: senderId,
        username: event.sender.username ?? null,
        firstName: event.sender.firstName ?? null,
        lastName: event.sender.lastName ?? null,
      });
      await db
        .update(knownUsers)
        .set({
          aliases: event.sender.aliases,
          language: event.sender.language ?? null,
        })
        .where(eq(knownUsers.userId, senderId));
    }

    if (event.chat.kind === "group") {
      await rememberGroupActivity({
        chatId,
        title: event.chat.title ?? null,
        type: event.chat.type ?? null,
        // Membership follows the same rule: a bot account is not a member of
        // anyone's group roster.
        userId: shadowSender ? senderId : null,
      });
      await db
        .update(knownGroups)
        .set({
          notes: event.chat.notes ?? null,
          language: event.chat.language ?? null,
        })
        .where(eq(knownGroups.chatId, chatId));

      // Participants keep the roster complete for the readers above. Only
      // ever inserted-if-missing — the event's roster labels are composed
      // strings, and clobbering stored profile names with nothing would
      // degrade every label they feed.
      for (const participant of event.context.participants) {
        const userId = parseScopedRef(participant.ref).id;
        if (shadowSender && userId === senderId) continue;
        await db
          .insert(knownUsers)
          .values({ userId, username: participant.username ?? null })
          .onConflictDoNothing();
        await db
          .update(knownUsers)
          .set({ aliases: participant.aliases })
          .where(eq(knownUsers.userId, userId));
        await recordGroupMembership(db, chatId, userId);
      }
    }
  } catch (err) {
    console.warn(
      "Shadow directory refresh failed (turn continues):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
