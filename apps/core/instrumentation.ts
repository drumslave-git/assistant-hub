/**
 * Next.js instrumentation entry point. `register()` runs once when a server
 * instance starts and boots the core's long-running pieces: the inbound-turn
 * queue consumer, the bus subscriber, and the background jobs (the Telegram
 * poller lives in the tg source app since the source split).
 *
 * The Node-only bootstrap (signal handlers, consumers) lives in a separate
 * module imported dynamically only on the Node.js runtime, so no Node
 * `process` APIs appear in this file's Edge-runtime analysis. Startup is
 * best-effort and non-blocking: server readiness is never gated on Redis or
 * the tg service — missing pieces surface on the dashboard and in logs.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("@/server/boot/register-node");
  registerNode();
}
