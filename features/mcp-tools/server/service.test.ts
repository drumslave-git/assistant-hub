import { describe, expect, it } from "vitest";

import {
  HISTORY_GET_BY_MESSAGE_IDS_TOOL,
  HISTORY_GET_IN_RANGE_TOOL,
  HISTORY_RECALL_TOOL,
  HISTORY_SEARCH_TOOL,
} from "@/features/history/server/mcp-tools";
import { BROWSE_WEB_TOOL } from "@/features/browser-agent/server/mcp-tools";
import { IMAGE_GENERATE_TOOL } from "@/features/image-gen/server/mcp-tools";
import { UPDATE_USER_ALIASES_TOOL } from "@/features/known-users/server/mcp-tools";
import { MEMORY_TOOL_NAMES } from "@/features/memory/server/mcp-tools";
import { SCHEDULED_TASKS_TOOL_NAMES } from "@/features/scheduled-tasks/server/mcp-tools";
import { getToolset, getToolsView } from "./service";

/**
 * MCP-tools service. The tool registry is shared, in-process, code-defined infra
 * (no DB); these tests confirm the operator-facing list and the reply toolset both
 * expose every registered tool (all tools are always available — no on/off).
 */

const ALL_TOOLS = [
  HISTORY_SEARCH_TOOL,
  HISTORY_GET_IN_RANGE_TOOL,
  HISTORY_GET_BY_MESSAGE_IDS_TOOL,
  HISTORY_RECALL_TOOL,
  UPDATE_USER_ALIASES_TOOL,
  ...SCHEDULED_TASKS_TOOL_NAMES,
  ...MEMORY_TOOL_NAMES,
  IMAGE_GENERATE_TOOL,
  BROWSE_WEB_TOOL,
].sort();

describe("getToolsView", () => {
  it("lists every registered tool with its owning feature and a description", async () => {
    const view = await getToolsView();
    expect(view.tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    const featureOf = (name: string) => view.tools.find((t) => t.name === name)?.feature;
    expect(featureOf(HISTORY_SEARCH_TOOL)).toBe("history");
    expect(featureOf(UPDATE_USER_ALIASES_TOOL)).toBe("known-users");
    expect(featureOf(SCHEDULED_TASKS_TOOL_NAMES[0])).toBe("scheduled-tasks");
    expect(featureOf(MEMORY_TOOL_NAMES[0])).toBe("memory");
    // The owning feature is what gives the tool its `mcp-tools-image-gen` Debug scope.
    expect(featureOf(IMAGE_GENERATE_TOOL)).toBe("image-gen");
    expect(featureOf(BROWSE_WEB_TOOL)).toBe("browser-agent");
    expect(view.tools.every((t) => t.description.length > 0)).toBe(true);
  });
});

describe("getToolset", () => {
  it("returns every registered tool in OpenAI shape with a callTool", async () => {
    const toolset = await getToolset();
    expect(toolset).not.toBeNull();
    expect(toolset!.tools.map((t) => t.function.name).sort()).toEqual(ALL_TOOLS);
    expect(typeof toolset!.callTool).toBe("function");
  });
});
