import type { BotPolicy } from "@/features/bot-messaging/server/policy";

/**
 * Reusable {@link BotPolicy} fixtures. Owner identity is no longer part of the
 * policy — the sender's `isOwner` stamp rides the inbound event — so the
 * shapes left are simply maintenance off and on.
 */

/** Maintenance off — every sender is served. */
export const openPolicy: BotPolicy = { maintenanceModeEnabled: false };

/** Maintenance on — only a sender stamped as owner gets through. */
export const maintenancePolicy: BotPolicy = { maintenanceModeEnabled: true };
