import { getToolsView } from "@/features/mcp-tools/server/service";
import { defineRoute, ok } from "@/server/http";

/**
 * Tools collection API. Lists every registered MCP tool with its enabled state.
 * Thin handler: the service reads the registry + settings.
 */
export const GET = defineRoute(async () => ok(await getToolsView()));
