import type { BotPolicy } from "@/features/settings/server/service";

/**
 * Owner and maintenance-mode policy. Pure and deterministic — no DB, no network —
 * so it is fully unit-testable and cheap to run per message. The {@link BotPolicy}
 * data (owner + maintenance state) is resolved by the settings service and passed
 * in; this module only decides.
 *
 * Maintenance mode: the bot stays functional for the owner (deterministic
 * addressing — private chat, reply, command, mention, exact display name — still
 * applies, but the LLM addressing analyzer is off for everyone) and is closed to
 * everyone else, who instead get a static maintenance notice.
 */

export type { BotPolicy };

/** Identity of the message sender, as far as owner matching needs. */
export interface MessageSender {
  fromId?: number;
}

/**
 * Whether the sender is the configured owner. The owner is chosen by id from the
 * known-users list, so this is an exact numeric-id match.
 */
export function isOwner(sender: MessageSender, policy: BotPolicy): boolean {
  return (
    policy.ownerUserId != null &&
    sender.fromId != null &&
    String(sender.fromId) === policy.ownerUserId
  );
}

export type MaintenanceDecision =
  | { blocked: false }
  | { blocked: true; reason: "not_owner" };

/**
 * Decide whether maintenance mode blocks an already-addressed message. Off →
 * never blocks. On → only the owner passes (with full normal behavior); everyone
 * else is blocked and shown a static maintenance notice.
 */
export function checkMaintenance(args: { policy: BotPolicy; owner: boolean }): MaintenanceDecision {
  if (!args.policy.maintenanceModeEnabled) return { blocked: false };
  if (!args.owner) return { blocked: true, reason: "not_owner" };
  return { blocked: false };
}
