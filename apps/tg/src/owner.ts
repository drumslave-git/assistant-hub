import { writeBackTransportConfig } from "./desired-state";

/**
 * The owner check, RESOLVED by the transport (owner identity is transport
 * config; the core only ever receives the flag on events). The identity
 * lives in the tg transport's config blob in the core store since the
 * registration slice; this holder carries the latest desired copy in memory
 * and writes the resolved numeric id back — Telegram has no lookup by
 * username, so it is learned the first time the owner messages a bot.
 */
export class OwnerConfig {
  private ownerUsername: string | null = null;
  private ownerUserId: string | null = null;

  /** Take the transport-level config from a desired-state fetch. */
  apply(config: Record<string, unknown>): void {
    this.ownerUsername =
      typeof config.ownerUsername === "string" && config.ownerUsername
        ? config.ownerUsername.toLowerCase()
        : null;
    this.ownerUserId =
      typeof config.ownerUserId === "string" && config.ownerUserId ? config.ownerUserId : null;
  }

  async resolveIsOwner(sender: {
    userId: string;
    username: string | null;
  }): Promise<boolean> {
    if (this.ownerUserId != null) return this.ownerUserId === sender.userId;
    if (!this.ownerUsername) return false;
    const username = sender.username?.toLowerCase() ?? null;
    if (!username || username !== this.ownerUsername) return false;
    // Learned: persist to the core's config blob (best-effort — the local
    // copy answers either way) and keep it locally for the next message.
    this.ownerUserId = sender.userId;
    await writeBackTransportConfig({ ownerUserId: sender.userId }).catch((err) => {
      console.error(
        "owner id write-back failed:",
        err instanceof Error ? err.message : String(err),
      );
    });
    return true;
  }
}
