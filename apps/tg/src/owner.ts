import type { TgDb } from "./db";
import { getTgSettings, setResolvedOwnerUserId } from "./store";

/**
 * The owner check, RESOLVED by the transport (owner identity is transport
 * config; the core only ever receives the flag on events). Matching the
 * configured @username resolves and persists the owner's numeric id — v1
 * semantics, unchanged by the de-storing (the config rows are the one
 * storage this app keeps until the registration slice moves them).
 */
export async function resolveIsOwner(
  db: TgDb,
  sender: { userId: string; username: string | null },
): Promise<boolean> {
  const settings = await getTgSettings(db).catch(() => ({
    ownerUsername: null,
    ownerUserId: null,
  }));
  if (settings.ownerUserId != null) return settings.ownerUserId === sender.userId;
  if (!settings.ownerUsername) return false;
  const username = sender.username?.toLowerCase() ?? null;
  if (!username || username !== settings.ownerUsername.toLowerCase()) return false;
  await setResolvedOwnerUserId(db, sender.userId).catch(() => undefined);
  return true;
}
