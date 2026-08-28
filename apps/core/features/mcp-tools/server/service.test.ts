import { describe, expect, it, vi } from "vitest";

import {
  HISTORY_GET_BY_MESSAGE_IDS_TOOL,
  HISTORY_GET_IN_RANGE_TOOL,
  HISTORY_RECALL_TOOL,
  HISTORY_SEARCH_TOOL,
} from "@/features/history/server/mcp-tools";
import { REPLY_TO_MESSAGE_TOOL } from "@/features/bot-messaging/server/mcp-tools";
import { BROWSE_WEB_TOOL } from "@/features/browser-agent/server/mcp-tools";
import { IMAGE_GENERATE_TOOL } from "@/features/image-gen/server/mcp-tools";
import { UPDATE_USER_ALIASES_TOOL } from "@/features/known-users/server/mcp-tools";
import { MEMORY_TOOL_NAMES } from "@/features/memory/server/mcp-tools";
import { RANDOMNESS_TOOL_NAMES, ROLL_CHANCE_TOOL } from "@/features/randomness/server/mcp-tools";
import { TASKS_TOOL_NAMES } from "@/features/tasks/server/mcp-tools";
import {
  SEND_MESSAGE_TOOL,
  TASKS_OUTBOUND_TOOL_NAMES,
} from "@/features/tasks/server/outbound-tools";
import { getToolset, getToolsView } from "./service";

/**
 * The connection half of the toolset needs the core store; these tests are
 * about the code-defined half and the delivery carve-out, so it is stubbed
 * empty here and driven for real in
 * `features/tool-connections/server/toolset.integration.test.ts`.
 */
vi.mock("@/features/tool-connections/server/toolset", () => ({
  resolveConnectionToolset: async () => ({
    tools: [],
    owns: () => false,
    callTool: async () => ({ text: "", isError: true }),
  }),
}));

/**
 * MCP-tools service. The tool registry is shared, in-process, code-defined infra
 * (no DB); these tests confirm the operator-facing list exposes every registered
 * tool, and that the one carve-out holds: the outbound delivery tools are
 * offered to task fires and withheld from reply turns (a reply's own text
 * already delivers itself).
 */

/**
 * Everything a turn gets regardless of how it delivers. The two delivery tools
 * are deliberately absent: a turn is offered at most one of them, and which one
 * is decided by the turn, not the model.
 */
const COMMON_TOOLS = [
  HISTORY_SEARCH_TOOL,
  HISTORY_GET_IN_RANGE_TOOL,
  HISTORY_GET_BY_MESSAGE_IDS_TOOL,
  HISTORY_RECALL_TOOL,
  UPDATE_USER_ALIASES_TOOL,
  ...TASKS_TOOL_NAMES,
  ...MEMORY_TOOL_NAMES,
  // Rolling a chance is not a delivery, so a reply turn gets it too: "from time
  // to time, do X" is written as a standing task but decided in an ordinary turn.
  ...RANDOMNESS_TOOL_NAMES,
  IMAGE_GENERATE_TOOL,
  BROWSE_WEB_TOOL,
].sort();

const ALL_TOOLS = [...COMMON_TOOLS, REPLY_TO_MESSAGE_TOOL, ...TASKS_OUTBOUND_TOOL_NAMES].sort();

describe("getToolsView", () => {
  it("lists every registered tool with its owning feature and a description", async () => {
    const view = await getToolsView();
    expect(view.tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
    const featureOf = (name: string) => view.tools.find((t) => t.name === name)?.feature;
    expect(featureOf(HISTORY_SEARCH_TOOL)).toBe("history");
    expect(featureOf(UPDATE_USER_ALIASES_TOOL)).toBe("known-users");
    expect(featureOf(TASKS_TOOL_NAMES[0])).toBe("tasks");
    expect(featureOf(SEND_MESSAGE_TOOL)).toBe("tasks");
    expect(featureOf(MEMORY_TOOL_NAMES[0])).toBe("memory");
    // The owning feature is what gives the tool its `mcp-tools-image-gen` Debug scope.
    expect(featureOf(IMAGE_GENERATE_TOOL)).toBe("image-gen");
    expect(featureOf(BROWSE_WEB_TOOL)).toBe("browser-agent");
    expect(featureOf(REPLY_TO_MESSAGE_TOOL)).toBe("bot-messaging");
    expect(featureOf(ROLL_CHANCE_TOOL)).toBe("randomness");
    expect(view.tools.every((t) => t.description.length > 0)).toBe(true);
  });
});

describe("getToolset", () => {
  const namesOf = async (options?: Parameters<typeof getToolset>[0]) => {
    const toolset = await getToolset(options);
    expect(toolset).not.toBeNull();
    return toolset!.tools.map((t) => t.function.name).sort();
  };

  it("offers an ordinary reply turn neither delivery tool", async () => {
    // Its own text is already on its way to the chat; a delivery tool here would
    // post the answer twice.
    expect(await namesOf()).toEqual(COMMON_TOOLS);
    expect(typeof (await getToolset())!.callTool).toBe("function");
  });

  it("offers a message-triggered turn the reply tool, and only that one", async () => {
    expect(await namesOf({ delivery: "reply" })).toEqual(
      [...COMMON_TOOLS, REPLY_TO_MESSAGE_TOOL].sort(),
    );
  });

  it("offers a timed fire the send tool, and only that one", async () => {
    // A fire has no triggering message, so being able to "reply" to one would be
    // an offer it could only fulfil by inventing a target.
    expect(await namesOf({ delivery: "send" })).toEqual(
      [...COMMON_TOOLS, SEND_MESSAGE_TOOL].sort(),
    );
  });

  it("never offers both at once, whichever kind is asked for", async () => {
    for (const delivery of ["reply", "send"] as const) {
      const names = await namesOf({ delivery });
      expect(names.filter((n) => n === REPLY_TO_MESSAGE_TOOL || n === SEND_MESSAGE_TOOL)).toHaveLength(1);
    }
  });
});
