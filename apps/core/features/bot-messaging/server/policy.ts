import type { BotPolicy } from "@/features/settings/server/service";

/**
 * Maintenance-mode policy. Pure and deterministic — no DB, no network — so it
 * is fully unit-testable and cheap to run per message. The {@link BotPolicy}
 * data (maintenance state) is resolved by the settings service and passed in;
 * whether the sender is the owner arrives with the inbound event
 * (`sender.isOwner`, stamped by the owning source — authoritative since the
 * split, the core matches no user ids of its own). This module only decides.
 *
 * Maintenance mode: the bot stays functional for the owner (deterministic
 * addressing — private chat, reply, command, mention, exact display name — still
 * applies, but the LLM addressing analyzer is off for everyone) and is closed to
 * everyone else, who instead get a static maintenance notice.
 */

export type { BotPolicy };

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
