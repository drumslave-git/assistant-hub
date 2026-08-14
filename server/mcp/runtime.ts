import "server-only";

import {
  BOT_MESSAGING_TOOL_NAMES,
  registerBotMessagingMcpTools,
} from "@/features/bot-messaging/server/mcp-tools";
import {
  BROWSER_AGENT_TOOL_NAMES,
  registerBrowserAgentMcpTools,
} from "@/features/browser-agent/server/mcp-tools";
import {
  HISTORY_TOOL_NAMES,
  registerHistoryMcpTools,
} from "@/features/history/server/mcp-tools";
import {
  IMAGE_GEN_TOOL_NAMES,
  registerImageGenMcpTools,
} from "@/features/image-gen/server/mcp-tools";
import {
  KNOWN_USERS_TOOL_NAMES,
  registerKnownUsersMcpTools,
} from "@/features/known-users/server/mcp-tools";
import {
  MEMORY_TOOL_NAMES,
  registerMemoryMcpTools,
} from "@/features/memory/server/mcp-tools";
import {
  registerSpecialistsMcpTools,
  SPECIALISTS_TOOL_NAMES,
} from "@/features/specialists/server/mcp-tools";
import { registerTasksMcpTools, TASKS_TOOL_NAMES } from "@/features/tasks/server/mcp-tools";
import {
  registerTasksOutboundMcpTools,
  TASKS_OUTBOUND_TOOL_NAMES,
} from "@/features/tasks/server/outbound-tools";
import { BotMcpRegistry, type McpToolRegistrar } from "./registry";

/**
 * Process-wide MCP registry. Tools are registered once and the in-process
 * client/server pair connects once; both the reply runtime (per turn) and the
 * Tools dashboard read the same registry. Kept on a `globalThis` singleton — like
 * the bot manager — so it survives module re-evaluation across Next bundles and
 * dev hot-reload, and the MCP server is never connected twice.
 *
 * New tool-owning features add their registrar here.
 */

interface RegistryStore {
  registry: BotMcpRegistry | null;
  loading: Promise<BotMcpRegistry> | null;
}

const STORE_KEY = Symbol.for("llm-tg-bot.mcp.registry");

function store(): RegistryStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: RegistryStore };
  if (!g[STORE_KEY]) g[STORE_KEY] = { registry: null, loading: null };
  return g[STORE_KEY];
}

/**
 * Every tool-owning feature, in registration order. A table rather than a
 * sequence of calls so the expected tool set can be read *without* building a
 * registry — which is what lets {@link loadMcpRegistry} notice that the cached
 * one predates the code now loaded.
 */
const REGISTRARS: { feature: string; registrar: McpToolRegistrar; toolNames: string[] }[] = [
  { feature: "history", registrar: registerHistoryMcpTools, toolNames: HISTORY_TOOL_NAMES },
  {
    feature: "bot-messaging",
    registrar: registerBotMessagingMcpTools,
    toolNames: BOT_MESSAGING_TOOL_NAMES,
  },
  {
    feature: "known-users",
    registrar: registerKnownUsersMcpTools,
    toolNames: KNOWN_USERS_TOOL_NAMES,
  },
  { feature: "tasks", registrar: registerTasksMcpTools, toolNames: TASKS_TOOL_NAMES },
  // The outbound delivery tools are the tasks feature's second registrar: same
  // trace scope, but a separate name list so `getToolset` can withhold them
  // from reply turns (only a task fire delivers through tools).
  {
    feature: "tasks",
    registrar: registerTasksOutboundMcpTools,
    toolNames: TASKS_OUTBOUND_TOOL_NAMES,
  },
  {
    feature: "specialists",
    registrar: registerSpecialistsMcpTools,
    toolNames: SPECIALISTS_TOOL_NAMES,
  },
  { feature: "memory", registrar: registerMemoryMcpTools, toolNames: MEMORY_TOOL_NAMES },
  { feature: "image-gen", registrar: registerImageGenMcpTools, toolNames: IMAGE_GEN_TOOL_NAMES },
  {
    feature: "browser-agent",
    registrar: registerBrowserAgentMcpTools,
    toolNames: BROWSER_AGENT_TOOL_NAMES,
  },
];

/** The tool names the currently loaded code registers. */
export function expectedToolNames(): string[] {
  return REGISTRARS.flatMap((entry) => entry.toolNames);
}

/** Build the registry, register every feature's tools, and connect. */
async function build(): Promise<BotMcpRegistry> {
  const registry = new BotMcpRegistry();
  for (const { feature, registrar, toolNames } of REGISTRARS) {
    registry.registerTools(feature, registrar, toolNames);
  }
  await registry.finishRegistration();
  return registry;
}

/** Same tool names, order-independent. */
function sameTools(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const have = new Set(a);
  return b.every((name) => have.has(name));
}

/**
 * Whether a cached registry still matches the code that is loaded now. It cannot
 * in production — the registrar table is compiled in — but it routinely cannot in
 * dev: the singleton survives hot reload *by design*, so a registry built before
 * a new feature's registrar existed keeps serving a tool list that no longer
 * matches the source. That is invisible in the worst way. The bot is simply never
 * offered the new tool, so it answers the request in prose and promises to do the
 * thing (exactly the false promise the base prompt's honesty rules exist to
 * prevent — and cannot, because there was no tool to call), while `/tools` shows
 * the same stale list and looks like a page that was never updated.
 */
function isCurrent(registry: BotMcpRegistry): boolean {
  // Read defensively: a cached instance can predate the *class* too, not only
  // the tool list — after a hot reload that added this very accessor, the
  // surviving object had no `registeredToolNames` at all. Anything but a real
  // array means the instance is older than the code asking the question, which
  // is the definition of stale.
  const registered: unknown = registry.registeredToolNames;
  if (!Array.isArray(registered)) return false;
  return sameTools(registered as string[], expectedToolNames());
}

/**
 * The shared MCP registry, loaded and connected. Idempotent and safe to call
 * concurrently — the first call builds it, the rest await the same promise. A
 * cached registry whose tool set no longer matches the loaded code is discarded
 * and rebuilt (see {@link isCurrent}); the replaced instance's transport is
 * in-process, so it holds nothing that needs closing.
 */
export async function loadMcpRegistry(): Promise<BotMcpRegistry> {
  const s = store();
  if (s.registry) {
    if (isCurrent(s.registry)) return s.registry;
    console.warn("MCP registry is stale (registered tools changed) — rebuilding");
    s.registry = null;
    s.loading = null;
  }
  if (!s.loading) {
    s.loading = build().then((registry) => {
      s.registry = registry;
      return registry;
    });
  }
  return s.loading;
}
