/**
 * Static build metadata. Safe on client and server: the values are inlined at
 * build time from package.json via `next.config.ts` `env` — importing
 * package.json here shipped the whole manifest (dependency list and versions)
 * into the browser bundle. Outside a Next build (unit tests), the env vars are
 * unset and the fallbacks apply.
 */
export const buildInfo = {
  name: process.env.NEXT_PUBLIC_APP_NAME ?? "llm-tg-bot-nextjs",
  version: process.env.NEXT_PUBLIC_APP_VERSION ?? "dev",
} as const;
