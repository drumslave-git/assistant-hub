/**
 * Environment access for the tg service. Bootstrap-only, like the core app
 * (config-in-DB direction): the store URL, Redis, the internal-API secret,
 * and the listen port. Everything else lives in the stores.
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
