import type { TurnLifecycleEvent } from "@assistant-hub/contracts";

/**
 * What the core is doing in a thread right now, as this app renders it.
 *
 * The core publishes a turn's lifecycle (accepted → progress → settled) and
 * each source renders it natively (PLAN.md): Telegram turns it into the
 * typing indicator, a web thread into live progress under the transcript.
 * The state is per running turn and worth nothing after a restart — the
 * transcript is the durable record — so it lives in this instance's memory,
 * the same shape tg's typing loops take.
 *
 * A turn that never settles must not leave a thread "thinking" forever, so an
 * entry expires on its own; the core's own settle is the normal way one goes.
 */

/** How long an unsettled turn keeps showing progress before it is ignored. */
const STALE_AFTER_MS = 10 * 60 * 1000;

export interface ThreadTurn {
  /** Source-local id of the message being answered. */
  sourceMessageId: string;
  /** Short label of what the turn is doing (a tool name), or null. */
  activity: string | null;
  /** When this turn was accepted. */
  since: Date;
  /** When the last lifecycle event for it arrived (the staleness clock). */
  updatedAt: Date;
}

export class ThreadTurns {
  private readonly active = new Map<string, ThreadTurn>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Apply one lifecycle event. Returns true when the thread's visible state
   * changed, so the caller pings the dashboard only when there is something
   * new to see.
   */
  apply(threadId: string, event: TurnLifecycleEvent): boolean {
    if (event.phase === "settled") return this.clear(threadId);
    const at = this.now();
    const existing = this.active.get(threadId);
    const activity = event.activity ?? null;
    const next: ThreadTurn = {
      sourceMessageId: event.sourceMessageId,
      activity,
      since: existing?.sourceMessageId === event.sourceMessageId ? existing.since : at,
      updatedAt: at,
    };
    this.active.set(threadId, next);
    return (
      existing?.sourceMessageId !== next.sourceMessageId || existing?.activity !== activity
    );
  }

  /** Forget a thread's turn (it settled, or the thread is gone). */
  clear(threadId: string): boolean {
    return this.active.delete(threadId);
  }

  /** The thread's running turn, or null when nothing is running (or it went stale). */
  get(threadId: string): ThreadTurn | null {
    const turn = this.active.get(threadId);
    if (!turn) return null;
    if (this.now().getTime() - turn.updatedAt.getTime() > STALE_AFTER_MS) {
      this.active.delete(threadId);
      return null;
    }
    return turn;
  }
}
