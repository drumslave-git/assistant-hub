import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  recordGroupMembership,
  upsertKnownGroup,
} from "@/features/known-groups/server/repository";
import { listTraces } from "@/server/trace";
import { startTestStoreDb, type TestStoreDb } from "@/test/store-db";
import { getKnownUser, upsertKnownUser } from "./repository";
import {
  addAliasByReference,
  getUserLanguage,
  listUsers,
  rememberUser,
  updateAliases,
  updateLanguage,
} from "./service";

// Curated directory edits land at the owning source first (the sources own
// their directories since the split); mocked so these tests assert the local
// shadow behavior without a live service. Edits name people by scoped ref.
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

describe("rememberUser", () => {
  it("captures a user on first message and refreshes the profile without touching aliases", async () => {
    await rememberUser("tg",
      { userId: "1", username: "ann", firstName: "Ann", lastName: null },
      ctx.db,
    );
    await updateAliases("tg:user:1", { aliases: ["Boss"] }, trigger, ctx.db);

    // A later message with a changed username refreshes the profile but keeps aliases.
    await rememberUser("tg",
      { userId: "1", username: "ann_new", firstName: "Ann", lastName: "Lee" },
      ctx.db,
    );

    const user = await getKnownUser(ctx.db, "tg", "1");
    expect(user).toMatchObject({
      userId: "1",
      username: "ann_new",
      firstName: "Ann",
      lastName: "Lee",
      aliases: ["Boss"],
    });
  });

  it("traces the capture only when it adds or changes data, not on re-sightings", async () => {
    const profile = { userId: "7", username: "sam", firstName: "Sam", lastName: null };

    // First sighting → one capture trace.
    await rememberUser("tg", profile, ctx.db);
    // Identical re-sighting → no new trace.
    await rememberUser("tg", profile, ctx.db);
    // Changed profile → an update-profile trace.
    await rememberUser("tg", { ...profile, lastName: "Vine" }, ctx.db);

    const { traces } = await listTraces({ feature: "known-users" });
    const captures = traces.filter((t) => t.action === "capture-user");
    const updates = traces.filter((t) => t.action === "update-profile");
    expect(captures).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(captures[0].status).toBe("success");
    expect(captures[0].relatedIds).toMatchObject({ known_users: ["7"] });
  });
});

describe("listUsers", () => {
  it("returns users most-recently-seen first", async () => {
    await upsertKnownUser(ctx.db, "tg", { userId: "1", username: "first", firstName: null, lastName: null });
    await upsertKnownUser(ctx.db, "tg", { userId: "2", username: "second", firstName: null, lastName: null });

    const users = await listUsers("tg", ctx.db);
    expect(users.map((u) => u.userId)).toEqual(["2", "1"]);
  });
});

describe("updateLanguage / getUserLanguage", () => {
  it("sets and clears the DM language, recording a trace and surviving profile upserts", async () => {
    await upsertKnownUser(ctx.db, "tg", { userId: "1", username: "ann", firstName: "Ann", lastName: null });

    // Unset → null (the runtime falls back to the default).
    expect(await getUserLanguage("tg", "1", ctx.db)).toBeNull();

    const set = await updateLanguage("tg:user:1", { language: "Ukrainian" }, trigger, ctx.db);
    expect(set.language).toBe("Ukrainian");
    expect(await getUserLanguage("tg", "1", ctx.db)).toBe("Ukrainian");

    // A later message must not wipe the operator-configured language.
    await rememberUser("tg", { userId: "1", username: "ann2", firstName: "Ann", lastName: null }, ctx.db);
    expect(await getUserLanguage("tg", "1", ctx.db)).toBe("Ukrainian");

    const cleared = await updateLanguage("tg:user:1", { language: null }, trigger, ctx.db);
    expect(cleared.language).toBeNull();

    const { traces } = await listTraces({ feature: "known-users" });
    const langTraces = traces.filter((t) => t.action === "update-language");
    expect(langTraces).toHaveLength(2);
    expect(langTraces.every((t) => t.status === "success")).toBe(true);
  });

  it("fails for an unknown user and records an error trace", async () => {
    await expect(
      updateLanguage("tg:user:404", { language: "Ukrainian" }, trigger, ctx.db),
    ).rejects.toThrow(/unknown user/i);
  });

  it("returns null language for an unknown user", async () => {
    expect(await getUserLanguage("tg", "404", ctx.db)).toBeNull();
  });
});

describe("updateAliases", () => {
  it("replaces the alias list and records a trace", async () => {
    await upsertKnownUser(ctx.db, "tg", { userId: "1", username: "ann", firstName: "Ann", lastName: null });

    const updated = await updateAliases("tg:user:1", { aliases: ["Boss", "Chief"] }, trigger, ctx.db);
    expect(updated.aliases).toEqual(["Boss", "Chief"]);

    const { traces } = await listTraces({ feature: "known-users" });
    expect(traces).toHaveLength(1);
    expect(traces[0].action).toBe("update-aliases");
    expect(traces[0].status).toBe("success");
  });

  it("fails for an unknown user and records an error trace", async () => {
    await expect(updateAliases("tg:user:404", { aliases: [] }, trigger, ctx.db)).rejects.toThrow(
      /unknown user/i,
    );
    const { traces } = await listTraces({ feature: "known-users" });
    expect(traces[0].status).toBe("error");
  });
});

describe("addAliasByReference", () => {
  // A group chat: participant resolution reads the (shadow-kept) membership
  // roster since the split — the mirror lives with the owning source.
  const CHAT = "-500";

  /** Make a known user a participant of a chat via the membership roster. */
  async function seedParticipant(
    profile: { userId: string; username: string | null; firstName: string | null; lastName: string | null },
    chatId = CHAT,
  ) {
    await upsertKnownUser(ctx.db, "tg", profile);
    await upsertKnownGroup(ctx.db, "tg", { chatId, title: "Fixture Group", type: "supergroup" });
    await recordGroupMembership(ctx.db, "tg", chatId, profile.userId);
  }

  it("resolves a participant by name and appends the new alias, tracing the change", async () => {
    await seedParticipant({ userId: "1", username: "alice", firstName: "Alice", lastName: "Anderson" });

    const result = await addAliasByReference(
      { source: "tg", chatId: CHAT, reference: "alice", aliases: ["Ali"] },
      { kind: "transport", actor: CHAT },
      ctx.db,
    );
    expect(result).toMatchObject({ status: "updated", added: ["Ali"] });
    expect((await getKnownUser(ctx.db, "tg", "1"))?.aliases).toEqual(["Ali"]);

    const { traces } = await listTraces({ feature: "known-users" });
    expect(traces[0]).toMatchObject({ action: "add-aliases", status: "success" });
  });

  it("returns not_found for a name that no participant matches", async () => {
    await seedParticipant({ userId: "1", username: "alice", firstName: "Alice", lastName: null });
    const result = await addAliasByReference(
      { source: "tg", chatId: CHAT, reference: "charlie", aliases: ["C"] },
      { kind: "transport", actor: CHAT },
      ctx.db,
    );
    expect(result).toEqual({ status: "not_found" });
    const { traces } = await listTraces({ feature: "known-users" });
    expect(traces[0].status).toBe("skipped");
  });

  it("returns ambiguous when the reference matches more than one participant", async () => {
    await seedParticipant({ userId: "1", username: "alice_a", firstName: "Alice", lastName: "Anderson" });
    await seedParticipant({ userId: "2", username: "alice_b", firstName: "Alice", lastName: "Brown" });
    const result = await addAliasByReference(
      { source: "tg", chatId: CHAT, reference: "Alice", aliases: ["Ali"] },
      { kind: "transport", actor: CHAT },
      ctx.db,
    );
    expect(result).toEqual({ status: "ambiguous", count: 2 });
  });

  it("is a no-op when the alias is already implied by the user's identity", async () => {
    await seedParticipant({ userId: "1", username: "alice", firstName: "Alice", lastName: null });
    const result = await addAliasByReference(
      { source: "tg", chatId: CHAT, reference: "alice", aliases: ["Alice", "@alice"] },
      { kind: "transport", actor: CHAT },
      ctx.db,
    );
    expect(result.status).toBe("noop");
    expect((await getKnownUser(ctx.db, "tg", "1"))?.aliases).toEqual([]);
  });

  it("only matches participants of the current chat, not users from other chats", async () => {
    await seedParticipant({ userId: "9", username: "alice", firstName: "Alice", lastName: null }, "-999");
    const result = await addAliasByReference(
      { source: "tg", chatId: CHAT, reference: "alice", aliases: ["Ali"] },
      { kind: "transport", actor: CHAT },
      ctx.db,
    );
    expect(result).toEqual({ status: "not_found" });
  });
});
