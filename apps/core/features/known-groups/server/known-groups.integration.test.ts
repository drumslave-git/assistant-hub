import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setKnownUserAliases, upsertKnownUser } from "@/features/known-users/server/repository";
import { listTraces } from "@/server/trace";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";
import { getGroupMembers, getKnownGroup } from "./repository";
import {
  getGroupContext,
  getGroupLanguage,
  listGroups,
  rememberGroupActivity,
  updateLanguage,
  updateNotes,
} from "./service";

// Curated directory edits land at the source first (the tg service owns
// the directory since the split); mocked so these tests assert the local
// shadow behavior without a live service.
vi.mock("@/server/source/directory", () => ({
  writeSourceUser: vi.fn(),
  writeSourceChat: vi.fn(),
}));

let ctx: TestStoreDb;

beforeAll(async () => {
  ctx = await startTestStoreDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "dashboard" } as const;

/** Seed a known user so the membership FK is satisfiable. */
async function seedUser(profile: {
  userId: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
}) {
  await upsertKnownUser(ctx.db, profile);
}

describe("rememberGroupActivity", () => {
  it("captures a group + member on first message and refreshes the title without touching notes", async () => {
    await seedUser({ userId: "1", username: "ann", firstName: "Ann", lastName: null });
    await rememberGroupActivity(
      { chatId: "-100", title: "Team", type: "supergroup", userId: "1" },
      ctx.db,
    );
    await updateNotes("tg:chat:-100", { notes: "Work group" }, trigger, ctx.db);

    // A later message with a renamed group refreshes the title but keeps notes.
    await rememberGroupActivity(
      { chatId: "-100", title: "Team (renamed)", type: "supergroup", userId: "1" },
      ctx.db,
    );

    const group = await getKnownGroup(ctx.db, "-100");
    expect(group).toMatchObject({ chatId: "-100", title: "Team (renamed)", notes: "Work group" });

    const members = await getGroupMembers(ctx.db, "-100");
    expect(members.map((m) => m.userId)).toEqual(["1"]);
  });

  it("traces only actual changes: new group, new member, profile change — not re-sightings", async () => {
    await seedUser({ userId: "1", username: "ann", firstName: "Ann", lastName: null });
    await seedUser({ userId: "2", username: "bo", firstName: "Bo", lastName: null });
    const G = { chatId: "-9", title: "Team", type: "group" as const };

    // New group + first member (folded into one capture trace).
    await rememberGroupActivity({ ...G, userId: "1" }, ctx.db);
    // Identical re-sighting from the same member → nothing new.
    await rememberGroupActivity({ ...G, userId: "1" }, ctx.db);
    // A second member joins the existing, unchanged group.
    await rememberGroupActivity({ ...G, userId: "2" }, ctx.db);
    // The group title changes (member 2 already known).
    await rememberGroupActivity({ ...G, title: "Team 2", userId: "2" }, ctx.db);

    const { traces } = await listTraces({ feature: "known-groups" });
    expect(traces.map((t) => t.action).sort()).toEqual([
      "capture-group",
      "member-joined",
      "update-profile",
    ]);
    expect(traces.every((t) => t.status === "success")).toBe(true);
    expect(traces.every((t) => t.relatedIds?.known_groups?.[0] === "-9")).toBe(true);
  });

  it("records membership only for the group the user spoke in", async () => {
    await seedUser({ userId: "1", username: "ann", firstName: "Ann", lastName: null });
    await rememberGroupActivity({ chatId: "-1", title: "A", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-2", title: "B", type: "group", userId: null }, ctx.db);

    expect((await getGroupMembers(ctx.db, "-1")).map((m) => m.userId)).toEqual(["1"]);
    expect(await getGroupMembers(ctx.db, "-2")).toEqual([]);
  });
});

describe("listGroups", () => {
  it("returns groups most-recently-seen first with member counts", async () => {
    await seedUser({ userId: "1", username: "a", firstName: null, lastName: null });
    await seedUser({ userId: "2", username: "b", firstName: null, lastName: null });
    await rememberGroupActivity({ chatId: "-1", title: "First", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-2", title: "Second", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-2", title: "Second", type: "group", userId: "2" }, ctx.db);

    const groups = await listGroups(ctx.db);
    expect(groups.map((g) => g.chatId)).toEqual(["-2", "-1"]);
    const second = groups.find((g) => g.chatId === "-2");
    expect(second?.memberCount).toBe(2);
  });
});

describe("updateNotes", () => {
  it("sets and clears notes, recording a trace each time", async () => {
    await rememberGroupActivity({ chatId: "-1", title: "G", type: "group", userId: null }, ctx.db);

    const set = await updateNotes("tg:chat:-1", { notes: "Casual" }, trigger, ctx.db);
    expect(set.notes).toBe("Casual");
    const cleared = await updateNotes("tg:chat:-1", { notes: null }, trigger, ctx.db);
    expect(cleared.notes).toBeNull();

    const { traces } = await listTraces({ feature: "known-groups" });
    const notesTraces = traces.filter((t) => t.action === "update-notes");
    expect(notesTraces).toHaveLength(2);
    expect(notesTraces.every((t) => t.status === "success")).toBe(true);
  });

  it("fails for an unknown group and records an error trace", async () => {
    await expect(updateNotes("tg:chat:-404", { notes: "x" }, trigger, ctx.db)).rejects.toThrow(
      /unknown group/i,
    );
    const { traces } = await listTraces({ feature: "known-groups" });
    expect(traces[0].status).toBe("error");
  });
});

describe("updateLanguage / getGroupLanguage", () => {
  it("sets and clears the language, recording a trace and preserving it across profile upserts", async () => {
    await rememberGroupActivity({ chatId: "-1", title: "G", type: "group", userId: null }, ctx.db);

    // Unset → null (the runtime falls back to the default).
    expect(await getGroupLanguage("-1", ctx.db)).toBeNull();

    const set = await updateLanguage("tg:chat:-1", { language: "Ukrainian" }, trigger, ctx.db);
    expect(set.language).toBe("Ukrainian");
    expect(await getGroupLanguage("-1", ctx.db)).toBe("Ukrainian");

    // A later message must not wipe the operator-configured language.
    await rememberGroupActivity({ chatId: "-1", title: "G renamed", type: "group", userId: null }, ctx.db);
    expect(await getGroupLanguage("-1", ctx.db)).toBe("Ukrainian");

    const cleared = await updateLanguage("tg:chat:-1", { language: null }, trigger, ctx.db);
    expect(cleared.language).toBeNull();
    expect(await getGroupLanguage("-1", ctx.db)).toBeNull();

    const { traces } = await listTraces({ feature: "known-groups" });
    const langTraces = traces.filter((t) => t.action === "update-language");
    expect(langTraces).toHaveLength(2);
    expect(langTraces.every((t) => t.status === "success")).toBe(true);
  });

  it("fails for an unknown group and records an error trace", async () => {
    await expect(
      updateLanguage("tg:chat:-404", { language: "Ukrainian" }, trigger, ctx.db),
    ).rejects.toThrow(/unknown group/i);
    const { traces } = await listTraces({ feature: "known-groups" });
    expect(traces[0].status).toBe("error");
  });

  it("returns null language for an unknown group", async () => {
    expect(await getGroupLanguage("-404", ctx.db)).toBeNull();
  });
});

describe("getGroupContext", () => {
  it("builds a roster block with member labels, aliases, and notes", async () => {
    await seedUser({ userId: "1", username: "testuser", firstName: "Ada", lastName: null });
    await setKnownUserAliases(ctx.db, "1", ["Cap", "Chief"]);
    await seedUser({ userId: "2", username: null, firstName: "Bob", lastName: "Jones" });
    await rememberGroupActivity({ chatId: "-1", title: "Family", type: "group", userId: "1" }, ctx.db);
    await rememberGroupActivity({ chatId: "-1", title: "Family", type: "group", userId: "2" }, ctx.db);
    await updateNotes("tg:chat:-1", { notes: "Keep it casual" }, trigger, ctx.db);

    const context = await getGroupContext("-1", ctx.db);
    expect(context?.memberCount).toBe(2);
    expect(context?.content).toContain('group "Family"');
    expect(context?.content).toContain("About this group: Keep it casual");
    // The whole line, id included. The id is not decoration: it is the only
    // thing a per-person task can be written against, and the block itself
    // tells the model never to guess one — so a roster that reached the prompt
    // without ids would leave it inventing them.
    expect(context?.content).toContain("- Ada (@testuser) [user id 1] — also known as: Cap, Chief");
    // No aliases → the label and id, and nothing trailing.
    expect(context?.content).toContain("- Bob Jones [user id 2]");
    expect(context?.content).not.toContain("- Bob Jones [user id 2] —");
  });

  it("returns null for a group with no members and no notes", async () => {
    await rememberGroupActivity({ chatId: "-1", title: "Empty", type: "group", userId: null }, ctx.db);
    expect(await getGroupContext("-1", ctx.db)).toBeNull();
  });

  it("returns null for an unknown group", async () => {
    expect(await getGroupContext("-404", ctx.db)).toBeNull();
  });
});
