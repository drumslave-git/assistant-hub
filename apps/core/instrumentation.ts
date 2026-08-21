/**
 * Next.js instrumentation entry point. `register()` runs once when a server
 * instance starts, which is where the in-process Telegram poller is autostarted
 * per the recorded decision.
 *
 * The Node-only bootstrap (poller + signal handlers) lives in a separate module
 * imported dynamically only on the Node.js runtime, so no Node `process` APIs
 * appear in this file's Edge-runtime analysis. Autostart is best-effort and
 * non-blocking: server readiness is never gated on reaching Telegram, and a
 * missing/invalid token surfaces on the dashboard rather than crashing boot.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("@/server/telegram/register-node");
  registerNode();
}
