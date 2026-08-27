/**
 * Bootstrap environment access for a source-app service (tg, chat, …).
 *
 * Env is bootstrap-only in this project — the store URL, Redis, the
 * internal-API secret and the listen port. Everything a human configures at
 * runtime lives in a store and is edited from the dashboard, so there is
 * nothing here to validate beyond "present or not".
 */

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string): string | null {
  return process.env[name] ?? null;
}
