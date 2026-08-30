import {
  transportDesiredStateSchema,
  type TransportDesiredState,
  type TransportRegistrationRequest,
} from "@assistant-hub/contracts";
import { INTERNAL_TOKEN_HEADER, optionalEnv, requireEnv } from "@assistant-hub/service";

/**
 * Self-registration and desired state (redesign Phase 7, PLAN.md "The
 * transport contract"): this app announces itself to the core at boot — id,
 * name, its own base URL, its MCP path, and the config field schemas the
 * dashboard renders — and receives its desired state in the same round trip.
 * Config changes arrive as `transport.config.changed` bus events; the app
 * refetches and reconciles. Zero local storage.
 */

const REGISTER_RETRY_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** What this transport announces about itself. */
export function registrationRequest(port: number): TransportRegistrationRequest {
  return {
    id: "tg",
    name: "Telegram",
    baseUrl: (optionalEnv("SELF_URL") ?? `http://localhost:${port}`).replace(/\/$/, ""),
    mcpPath: "/mcp",
    connectionConfigSchema: [
      {
        key: "botToken",
        label: "Bot token",
        kind: "secret",
        required: true,
        help:
          "From @BotFather. Stored by the core; never shown again. " +
          "The bot starts polling as soon as it connects.",
      },
    ],
    transportConfigSchema: [
      {
        key: "ownerUsername",
        label: "Owner @username",
        kind: "text",
        help: "The Telegram @username whose messages carry owner rights.",
      },
      {
        key: "ownerUserId",
        label: "Owner user id",
        kind: "text",
        help: "Resolved automatically the first time the owner messages a bot.",
      },
    ],
  };
}

function coreApi(): { baseUrl: string; token: string } {
  const baseUrl = (optionalEnv("CORE_API_URL") ?? "http://localhost:3200").replace(/\/$/, "");
  return { baseUrl, token: requireEnv("INTERNAL_API_TOKEN") };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const { baseUrl, token } = coreApi();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      [INTERNAL_TOKEN_HEADER]: token,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`core ${path} answered ${res.status}`);
  }
  return res.json();
}

/** Register once; the response is the desired state to reconcile from. */
export async function registerWithCore(port: number): Promise<TransportDesiredState> {
  return transportDesiredStateSchema.parse(
    await request("/api/internal/transports/register", {
      method: "POST",
      body: JSON.stringify(registrationRequest(port)),
    }),
  );
}

/** Refetch the desired state (on a config-changed event). */
export async function fetchDesiredState(): Promise<TransportDesiredState> {
  return transportDesiredStateSchema.parse(await request("/api/internal/transports/tg/desired"));
}

/** Write back into this transport's own config blob (the resolved owner id). */
export async function writeBackTransportConfig(
  patch: Record<string, unknown>,
): Promise<void> {
  await request("/api/internal/transports/tg/config", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * Register, retrying until the core answers — the core may boot after this
 * app, and a transport with no desired state has nothing to run.
 */
export async function registerUntilAccepted(port: number): Promise<TransportDesiredState> {
  for (;;) {
    try {
      return await registerWithCore(port);
    } catch (err) {
      console.warn(
        `registration with the core failed (${err instanceof Error ? err.message : String(err)}) — ` +
          `retrying in ${REGISTER_RETRY_MS / 1000}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, REGISTER_RETRY_MS));
    }
  }
}
