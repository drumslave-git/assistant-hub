import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runWithToolContext } from "@/server/mcp/context";

import { BROWSE_WEB_TOOL, registerBrowserAgentMcpTools } from "./mcp-tools";

/**
 * The `browse_web` gate. Anyone may start a run; the download tool *inside* the
 * run is owner-only, and that is decided here, once, from the turn's authority.
 *
 * Authority is not the same as identity: a standing chat rule lends its author's
 * rights to the actions it calls for ("rule creator beats message source" —
 * user decision, 2026-07-29), so an owner's "download any media link posted
 * here" rule downloads everyone's links. The run's provenance must still record
 * the real sender.
 */

vi.mock("@/features/settings/server/service", () => ({ getBotPolicy: vi.fn() }));
vi.mock("./service", () => ({ enqueueBrowserRun: vi.fn() }));
vi.mock("./signal", () => ({ emitRunEnqueued: vi.fn() }));

const settings = vi.mocked(await import("@/features/settings/server/service"));
const service = vi.mocked(await import("./service"));

const OWNER = "1";
const OTHER = "77";

function handler() {
  let registered: ((args: { goal: string }) => Promise<unknown>) | null = null;
  const server = {
    registerTool: (_name: string, _config: unknown, fn: unknown) => {
      registered = fn as (args: { goal: string }) => Promise<unknown>;
    },
  } as unknown as McpServer;
  registerBrowserAgentMcpTools(server);
  return registered!;
}

beforeEach(() => {
  vi.clearAllMocks();
  settings.getBotPolicy.mockResolvedValue({ ownerUserId: OWNER, maintenanceModeEnabled: false });
  service.enqueueBrowserRun.mockResolvedValue({ id: "run-1" } as never);
});

/** The enqueued run's fields, after invoking the tool in the given context. */
async function enqueuedFrom(ctx: { userId: string | null; authorityUserId?: string | null }) {
  const run = handler();
  await runWithToolContext({ chatId: "-1001", ...ctx }, () =>
    run({ goal: "Download the video at https://example.com/clip" }),
  );
  return vi.mocked(service.enqueueBrowserRun).mock.calls[0][0];
}

describe(`${BROWSE_WEB_TOOL} download rights`, () => {
  it("grants them to the owner's own request", async () => {
    expect(await enqueuedFrom({ userId: OWNER })).toMatchObject({
      isOwner: true,
      createdByUserId: OWNER,
    });
  });

  it("withholds them from anyone else's own request", async () => {
    expect(await enqueuedFrom({ userId: OTHER })).toMatchObject({
      isOwner: false,
      createdByUserId: OTHER,
    });
  });

  it("grants them when a rule the owner set drove the turn, whoever sent the message", async () => {
    const enqueued = await enqueuedFrom({ userId: OTHER, authorityUserId: OWNER });

    expect(enqueued).toMatchObject({ isOwner: true });
    // Authority is permission, never identity: the run is still recorded as
    // started by the person whose message triggered it.
    expect(enqueued).toMatchObject({ createdByUserId: OTHER });
  });

  it("withholds them when the matched rule's author had none to lend", async () => {
    // `resolveRuleAuthority` returns null for a rule an ordinary user wrote, and
    // a null authority must not be read as "no check needed".
    expect(await enqueuedFrom({ userId: OTHER, authorityUserId: null })).toMatchObject({
      isOwner: false,
    });
  });

  it("withholds them from everyone when no owner is configured", async () => {
    settings.getBotPolicy.mockResolvedValue({ ownerUserId: null, maintenanceModeEnabled: false });

    expect(await enqueuedFrom({ userId: OTHER, authorityUserId: null })).toMatchObject({
      isOwner: false,
    });
  });
});

describe(`${BROWSE_WEB_TOOL} acknowledgement wiring`, () => {
  it("reports the enqueued run to the turn, so its reply becomes the deletable ack", async () => {
    const runIds: string[] = [];
    const run = handler();

    await runWithToolContext(
      { chatId: "-1001", userId: OWNER, onBrowserRunEnqueued: (id) => runIds.push(id) },
      () => run({ goal: "Download the video at https://example.com/clip" }),
    );

    expect(runIds).toEqual(["run-1"]);
  });
});
