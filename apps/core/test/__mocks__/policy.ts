import type { BotPolicy } from "@/features/bot-messaging/server/policy";

/**
 * Reusable {@link BotPolicy} fixtures. The messaging service and the policy
 * unit tests both exercise the same handful of policy shapes: fully open, an
 * owner-gated maintenance mode, and no configured owner.
 */

/** No owner, maintenance off — every sender is served. */
export const openPolicy: BotPolicy = { ownerUserId: null, maintenanceModeEnabled: false };

/** Owner is user `42`, maintenance on — only the owner gets through. */
export const ownerMaintenancePolicy: BotPolicy = {
  ownerUserId: "42",
  maintenanceModeEnabled: true,
};

/** Maintenance on but no owner configured — everyone is blocked. */
export const ownerlessMaintenancePolicy: BotPolicy = {
  ownerUserId: null,
  maintenanceModeEnabled: true,
};
