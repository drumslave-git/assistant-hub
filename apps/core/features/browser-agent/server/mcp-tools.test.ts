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

vi.mock("./service", () => ({ enqueueBrowserRun: vi.fn() }));
vi.mock("./signal", () => ({ emitRunEnqueued: vi.fn() }));
// A "group" is a chat the directory holds a row for, and the tool asks the
// repository; stubbed so this unit test needs no database.
const { GROUP } = vi.hoisted(() => ({ GROUP: "-1001" }));
vi.mock("@/features/known-groups/server/repository", () => ({
  isGroupChat: vi.fn(async (_db: unknown, _source: string, chatId: string) => chatId === GROUP),
}));

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
  service.enqueueBrowserRun.mockResolvedValue({ id: "run-1" } as never);
});

/** The enqueued run's fields, after invoking the tool in the given context. */
async function enqueuedFrom(ctx: {
  userId: string | null;
  senderIsOwner?: boolean;
  authorityIsOwner?: boolean;
  messageUrls?: string[];
  chatId?: string;
}) {
  const run = handler();
  await runWithToolContext({ source: "tg", chatId: GROUP, ...ctx }, () =>
    run({ goal: "Download the video at https://example.com/clip" }),
  );
  return vi.mocked(service.enqueueBrowserRun).mock.calls[0][0];
}

describe(`${BROWSE_WEB_TOOL} download rights`, () => {
  it("grants them to the owner's own request, unrestricted", async () => {
    expect(await enqueuedFrom({ userId: OWNER, senderIsOwner: true })).toMatchObject({
      isOwner: true,
      restricted: false,
      createdByUserRef: `tg:user:${OWNER}`,
    });
  });

  it("withholds them from anyone else's own request", async () => {
    expect(await enqueuedFrom({ userId: OTHER })).toMatchObject({
      isOwner: false,
      createdByUserRef: `tg:user:${OTHER}`,
    });
  });

  it("grants them when a rule the owner set drove the turn, whoever sent the message", async () => {
    const enqueued = await enqueuedFrom({ userId: OTHER, authorityIsOwner: true });

    // Borrowed rights restrict the run: downloads are fenced to the triggering
    // message's own links and must attach to the chat or be discarded.
    expect(enqueued).toMatchObject({ isOwner: true, restricted: true });
    // Authority is permission, never identity: the run is still recorded as
    // started by the person whose message triggered it.
    expect(enqueued).toMatchObject({ createdByUserRef: `tg:user:${OTHER}` });
  });

  it("restricts the owner's own rule-driven run in a group", async () => {
    // "It has to be the same for the owner in a group chat" (user decision,
    // 2026-08-01): a rule-driven download in a group is limited to what
    // Telegram can send, whoever posted the link — the group's audience cannot
    // reach the server's disk either way.
    expect(
      await enqueuedFrom({ userId: OWNER, senderIsOwner: true, authorityIsOwner: true }),
    ).toMatchObject({
      isOwner: true,
      restricted: true,
    });
  });

  it("leaves the owner's own rule-driven run in their DM unrestricted", async () => {
    expect(
      await enqueuedFrom({
        userId: OWNER,
        senderIsOwner: true,
        authorityIsOwner: true,
        chatId: OWNER,
      }),
    ).toMatchObject({ isOwner: true, restricted: false });
  });

  it("carries the message's code-extracted URLs onto the run verbatim", async () => {
    const urls = ["https://youtu.be/oh9VTJFPzHo?si=7OBKm0Ft5918u0yd"];

    expect(await enqueuedFrom({ userId: OTHER, authorityIsOwner: true, messageUrls: urls })).toMatchObject(
      { sourceUrls: urls },
    );
  });

  it("withholds them when the matched rule's author had none to lend", async () => {
    // `taskLendsOwnerRights` is false for a rule an ordinary user wrote, and
    // that must not be read as "no check needed".
    expect(await enqueuedFrom({ userId: OTHER, authorityIsOwner: false })).toMatchObject({
      isOwner: false,
    });
  });
});

describe(`${BROWSE_WEB_TOOL} acknowledgement wiring`, () => {
  it("reports the enqueued run to the turn, so its reply becomes the deletable ack", async () => {
    const runIds: string[] = [];
    const run = handler();

    await runWithToolContext(
      { source: "tg", chatId: GROUP, userId: OWNER, onBrowserRunEnqueued: (id) => runIds.push(id) },
      () => run({ goal: "Download the video at https://example.com/clip" }),
    );

    expect(runIds).toEqual(["run-1"]);
  });
});
