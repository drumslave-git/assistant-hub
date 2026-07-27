import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { upsertSettings } from "@/features/settings/server/repository";
import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";
import { listSpecialists } from "./repository";
import type { Specialist } from "./schema";
import { MAX_ENTRY_PAYLOAD_BYTES } from "./schema";
import {
  createSpecialist,
  deleteEntry,
  editSpecialist,
  getActiveSpecialist,
  getActiveSpecialistInstructions,
  getEntriesBrowserView,
  getSpecialistsView,
  queryEntriesForChat,
  removeSpecialist,
  saveEntry,
  setChatSpecialist,
  switchSpecialistFromChat,
  updateEntry,
} from "./service";

let ctx: TestDb;
/** The seed rows as they exist right after migrations, before any truncate. */
let seeded: Awaited<ReturnType<typeof listSpecialists>> = [];

beforeAll(async () => {
  ctx = await startTestDb();
  seeded = await listSpecialists(ctx.db);
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "dashboard" } as const;

/** A group chat id (negative) and DM ids (positive, equal to the user id). */
const GROUP = "-1001";
const DM_USER = "100";
const OTHER_USER = "200";

function create(over: Partial<Parameters<typeof createSpecialist>[0]> = {}) {
  return createSpecialist(
    { name: "Journal", description: "", instructions: "Keep a journal.", dataScope: "per-chat", ...over },
    trigger,
    ctx.db,
  );
}

describe("seed specialists", () => {
  it("ships three editable seed rows with the decided scopes", () => {
    // Captured in beforeAll straight after migrations ran (truncate wipes them —
    // which is exactly the point: they are ordinary rows, not fixtures).
    expect(seeded.map((s) => s.name).sort()).toEqual([
      "Daily psycho journal",
      "Grocery management",
      "Planning advisor",
    ]);
    const byName = new Map(seeded.map((s) => [s.name, s]));
    expect(byName.get("Daily psycho journal")?.dataScope).toBe("per-chat");
    expect(byName.get("Grocery management")?.dataScope).toBe("shared");
    expect(byName.get("Planning advisor")?.dataScope).toBe("per-chat");
    for (const s of seeded) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.instructions.length).toBeGreaterThan(0);
    }
  });
});

describe("specialist CRUD", () => {
  it("creates a specialist and lists it with no activations", async () => {
    const created = await create();
    expect(created.id).toBeTruthy();
    expect(created).toMatchObject({ name: "Journal", dataScope: "per-chat" });

    const view = await getSpecialistsView(ctx.db);
    expect(view.specialists.map((s) => s.name)).toEqual(["Journal"]);
    expect(view.assignments).toEqual([]);
  });

  it("rejects a duplicate name case-insensitively", async () => {
    await create();
    await expect(create({ name: "journal" })).rejects.toThrow(/already exists/i);
  });

  it("updates fields and preserves the others", async () => {
    const s = await create();
    const updated = await editSpecialist(s.id, { dataScope: "shared" }, trigger, ctx.db);
    expect(updated).toMatchObject({ name: "Journal", instructions: "Keep a journal.", dataScope: "shared" });
  });

  it("deleting a specialist cascades its activation and entries away", async () => {
    const s = await create();
    await setChatSpecialist({ chatId: DM_USER, specialistId: s.id }, trigger, ctx.db);
    await saveEntry(
      { specialist: s, chatId: DM_USER, authorUserId: DM_USER, collection: "journal", payload: { note: "day one" } },
      trigger,
      ctx.db,
    );

    await removeSpecialist(s.id, trigger, ctx.db);
    expect((await getSpecialistsView(ctx.db)).specialists).toHaveLength(0);
    expect((await getSpecialistsView(ctx.db)).assignments).toHaveLength(0);
    expect((await getEntriesBrowserView({}, ctx.db)).entries).toHaveLength(0);
    expect(await getActiveSpecialist(DM_USER, ctx.db)).toBeNull();
  });
});

describe("dashboard assignment", () => {
  it("sets and clears a chat's active specialist", async () => {
    const s = await create();
    const view = await setChatSpecialist({ chatId: GROUP, specialistId: s.id }, trigger, ctx.db);
    expect(view.assignments).toMatchObject([{ chatId: GROUP, specialistId: s.id }]);
    expect(await getActiveSpecialistInstructions(GROUP, ctx.db)).toBe("Keep a journal.");

    const cleared = await setChatSpecialist({ chatId: GROUP, specialistId: null }, trigger, ctx.db);
    expect(cleared.assignments).toEqual([]);
    expect(await getActiveSpecialistInstructions(GROUP, ctx.db)).toBeNull();
  });

  it("rejects assigning a specialist that does not exist", async () => {
    await expect(
      setChatSpecialist({ chatId: GROUP, specialistId: "ghost" }, trigger, ctx.db),
    ).rejects.toThrow(/does not exist/i);
  });
});

describe("chat-side switch gating", () => {
  it("lets a user switch and clear their own DM's specialist by name", async () => {
    await create();
    const switched = await switchSpecialistFromChat(
      { chatId: DM_USER, userId: DM_USER, specialistName: "journal" },
      trigger,
      ctx.db,
    );
    expect(switched.status).toBe("switched");
    expect(await getActiveSpecialistInstructions(DM_USER, ctx.db)).toBe("Keep a journal.");

    const cleared = await switchSpecialistFromChat(
      { chatId: DM_USER, userId: DM_USER, specialistName: null },
      trigger,
      ctx.db,
    );
    expect(cleared.status).toBe("cleared");
    expect(await getActiveSpecialistInstructions(DM_USER, ctx.db)).toBeNull();
  });

  it("reports an unknown name without changing the activation", async () => {
    const result = await switchSpecialistFromChat(
      { chatId: DM_USER, userId: DM_USER, specialistName: "Nope" },
      trigger,
      ctx.db,
    );
    expect(result).toMatchObject({ status: "not_found", name: "Nope" });
    expect(await getActiveSpecialist(DM_USER, ctx.db)).toBeNull();
  });

  it("denies switching in a group for a non-owner (and with no owner configured)", async () => {
    await create();
    // No owner configured: everyone is denied.
    const noOwner = await switchSpecialistFromChat(
      { chatId: GROUP, userId: DM_USER, specialistName: "Journal" },
      trigger,
      ctx.db,
    );
    expect(noOwner.status).toBe("denied");

    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const notOwner = await switchSpecialistFromChat(
      { chatId: GROUP, userId: OTHER_USER, specialistName: "Journal" },
      trigger,
      ctx.db,
    );
    expect(notOwner.status).toBe("denied");
    expect(await getActiveSpecialist(GROUP, ctx.db)).toBeNull();
  });

  it("lets the owner switch a group's specialist", async () => {
    await create();
    await upsertSettings(ctx.db, { ownerUserId: DM_USER });
    const result = await switchSpecialistFromChat(
      { chatId: GROUP, userId: DM_USER, specialistName: "Journal" },
      trigger,
      ctx.db,
    );
    expect(result.status).toBe("switched");
    expect(await getActiveSpecialistInstructions(GROUP, ctx.db)).toBe("Keep a journal.");
  });
});

describe("entry scope", () => {
  async function entriesIn(specialist: Specialist, chatId: string) {
    const { entries } = await queryEntriesForChat({ specialist, chatId }, ctx.db);
    return entries;
  }

  it("per-chat scope silos each chat's entries", async () => {
    const s = await create({ dataScope: "per-chat" });
    await saveEntry(
      { specialist: s, chatId: DM_USER, authorUserId: DM_USER, collection: "journal", payload: { note: "dm note" } },
      trigger,
      ctx.db,
    );
    await saveEntry(
      { specialist: s, chatId: GROUP, authorUserId: OTHER_USER, collection: "journal", payload: { note: "group note" } },
      trigger,
      ctx.db,
    );

    expect((await entriesIn(s, DM_USER)).map((e) => e.payload)).toEqual([{ note: "dm note" }]);
    expect((await entriesIn(s, GROUP)).map((e) => e.payload)).toEqual([{ note: "group note" }]);
  });

  it("shared scope reads one pool across chats, provenance intact", async () => {
    const s = await create({ name: "Groceries", dataScope: "shared" });
    await saveEntry(
      { specialist: s, chatId: DM_USER, authorUserId: DM_USER, collection: "groceries", payload: { item: "milk" } },
      trigger,
      ctx.db,
    );
    await saveEntry(
      { specialist: s, chatId: GROUP, authorUserId: OTHER_USER, collection: "groceries", payload: { item: "bread" } },
      trigger,
      ctx.db,
    );

    const fromDm = await entriesIn(s, DM_USER);
    expect(fromDm.map((e) => e.payload.item).sort()).toEqual(["bread", "milk"]);
    // Provenance is always recorded even when reads are shared.
    const bread = fromDm.find((e) => e.payload.item === "bread");
    expect(bread).toMatchObject({ chatId: GROUP, authorUserId: OTHER_USER });
  });

  it("update/delete cannot cross a per-chat silo", async () => {
    const s = await create({ dataScope: "per-chat" });
    const entry = await saveEntry(
      { specialist: s, chatId: DM_USER, authorUserId: DM_USER, collection: "journal", payload: { note: "mine" } },
      trigger,
      ctx.db,
    );

    await expect(
      updateEntry({ specialist: s, chatId: GROUP, id: entry.id, payload: { note: "stolen" } }, trigger, ctx.db),
    ).rejects.toThrow(/no such entry/i);
    await expect(
      deleteEntry({ specialist: s, chatId: GROUP, id: entry.id }, trigger, ctx.db),
    ).rejects.toThrow(/no such entry/i);

    const updated = await updateEntry(
      { specialist: s, chatId: DM_USER, id: entry.id, payload: { note: "edited" } },
      trigger,
      ctx.db,
    );
    expect(updated.payload).toEqual({ note: "edited" });
    await deleteEntry({ specialist: s, chatId: DM_USER, id: entry.id }, trigger, ctx.db);
    expect(await entriesIn(s, DM_USER)).toEqual([]);
  });

  it("caps the entry payload size", async () => {
    const s = await create();
    const oversized = { blob: "x".repeat(MAX_ENTRY_PAYLOAD_BYTES + 1) };
    await expect(
      saveEntry(
        { specialist: s, chatId: DM_USER, authorUserId: DM_USER, collection: "journal", payload: oversized },
        trigger,
        ctx.db,
      ),
    ).rejects.toThrow(/too large/i);
  });

  it("filters by collection and contains, and lists collections", async () => {
    const s = await create();
    await saveEntry(
      { specialist: s, chatId: DM_USER, authorUserId: null, collection: "journal", payload: { note: "slept well" } },
      trigger,
      ctx.db,
    );
    await saveEntry(
      { specialist: s, chatId: DM_USER, authorUserId: null, collection: "plans", payload: { title: "learn piano" } },
      trigger,
      ctx.db,
    );

    const { entries, collections } = await queryEntriesForChat(
      { specialist: s, chatId: DM_USER, collection: "journal" },
      ctx.db,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toEqual({ note: "slept well" });
    expect(collections.sort()).toEqual(["journal", "plans"]);

    const { entries: byText } = await queryEntriesForChat(
      { specialist: s, chatId: DM_USER, contains: "piano" },
      ctx.db,
    );
    expect(byText.map((e) => e.collection)).toEqual(["plans"]);
  });
});

describe("entries browser", () => {
  it("filters by specialist, chat, and collection", async () => {
    const a = await create({ name: "A" });
    const b = await create({ name: "B" });
    await saveEntry(
      { specialist: a, chatId: DM_USER, authorUserId: null, collection: "one", payload: { from: "a" } },
      trigger,
      ctx.db,
    );
    await saveEntry(
      { specialist: b, chatId: GROUP, authorUserId: null, collection: "two", payload: { from: "b" } },
      trigger,
      ctx.db,
    );

    expect((await getEntriesBrowserView({}, ctx.db)).entries).toHaveLength(2);
    expect((await getEntriesBrowserView({ specialistId: a.id }, ctx.db)).entries).toMatchObject([
      { payload: { from: "a" } },
    ]);
    expect((await getEntriesBrowserView({ chatId: GROUP }, ctx.db)).entries).toMatchObject([
      { payload: { from: "b" } },
    ]);
    expect((await getEntriesBrowserView({ collection: "two" }, ctx.db)).entries).toMatchObject([
      { payload: { from: "b" } },
    ]);
  });
});

describe("trace recording", () => {
  it("records a trace for each mutation", async () => {
    const s = await create();
    await editSpecialist(s.id, { description: "x" }, trigger, ctx.db);
    await setChatSpecialist({ chatId: DM_USER, specialistId: s.id }, trigger, ctx.db);
    await switchSpecialistFromChat(
      { chatId: DM_USER, userId: DM_USER, specialistName: null },
      trigger,
      ctx.db,
    );
    const entry = await saveEntry(
      { specialist: s, chatId: DM_USER, authorUserId: DM_USER, collection: "journal", payload: { note: "n" } },
      trigger,
      ctx.db,
    );
    await updateEntry(
      { specialist: s, chatId: DM_USER, id: entry.id, payload: { note: "m" } },
      trigger,
      ctx.db,
    );
    await deleteEntry({ specialist: s, chatId: DM_USER, id: entry.id }, trigger, ctx.db);
    await removeSpecialist(s.id, trigger, ctx.db);

    const { traces } = await listTraces({ feature: "specialists" });
    const actions = traces.map((t) => t.action).sort();
    expect(actions).toEqual([
      "assign",
      "create",
      "delete",
      "entry-delete",
      "entry-save",
      "entry-update",
      "switch",
      "update",
    ]);
    expect(traces.every((t) => t.status === "success")).toBe(true);
  });
});
