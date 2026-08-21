import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { listTraces } from "@/server/trace";
import { startTestDb, type TestDb } from "@/test/db";
import { getSettingsRecord } from "@/features/settings/server/repository";
import {
  createPersonality,
  editPersonality,
  getActivePersonalityPrompt,
  getPersonalitiesView,
  removePersonality,
  setActivePersonality,
} from "./service";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await startTestDb();
});

afterAll(async () => {
  await ctx?.stop();
});

beforeEach(async () => {
  await ctx.truncate();
});

const trigger = { kind: "dashboard" } as const;

describe("createPersonality", () => {
  it("creates a personality and lists it with no active selection", async () => {
    const created = await createPersonality({ name: "Pirate", prompt: "Arr." }, trigger, ctx.db);
    expect(created.id).toBeTruthy();
    expect(created).toMatchObject({ name: "Pirate", prompt: "Arr." });

    const view = await getPersonalitiesView(ctx.db);
    expect(view.personalities.map((p) => p.name)).toEqual(["Pirate"]);
    expect(view.activeId).toBeNull();
  });

  it("rejects a duplicate name case-insensitively", async () => {
    await createPersonality({ name: "Pirate", prompt: "" }, trigger, ctx.db);
    await expect(
      createPersonality({ name: "pirate", prompt: "" }, trigger, ctx.db),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("editPersonality", () => {
  it("updates fields and preserves the others", async () => {
    const p = await createPersonality({ name: "A", prompt: "one" }, trigger, ctx.db);
    const updated = await editPersonality(p.id, { prompt: "two" }, trigger, ctx.db);
    expect(updated).toMatchObject({ name: "A", prompt: "two" });
  });

  it("rejects an unknown id and a rename onto an existing name", async () => {
    await expect(editPersonality("nope", { name: "X" }, trigger, ctx.db)).rejects.toThrow(
      /unknown personality/i,
    );
    await createPersonality({ name: "Taken", prompt: "" }, trigger, ctx.db);
    const other = await createPersonality({ name: "Other", prompt: "" }, trigger, ctx.db);
    await expect(editPersonality(other.id, { name: "taken" }, trigger, ctx.db)).rejects.toThrow(
      /already exists/i,
    );
  });
});

describe("setActivePersonality", () => {
  it("sets and clears the active selection, resolving its prompt", async () => {
    const p = await createPersonality({ name: "Bard", prompt: "Sing." }, trigger, ctx.db);
    // No active selection → no prompt.
    expect(await getActivePersonalityPrompt(ctx.db)).toBeNull();

    const view = await setActivePersonality(p.id, trigger, ctx.db);
    expect(view.activeId).toBe(p.id);
    expect((await getSettingsRecord(ctx.db))?.activePersonalityId).toBe(p.id);
    expect(await getActivePersonalityPrompt(ctx.db)).toBe("Sing.");

    const cleared = await setActivePersonality(null, trigger, ctx.db);
    expect(cleared.activeId).toBeNull();
    expect(await getActivePersonalityPrompt(ctx.db)).toBeNull();
  });

  it("rejects activating a personality that does not exist", async () => {
    await expect(setActivePersonality("ghost", trigger, ctx.db)).rejects.toThrow(
      /does not exist/i,
    );
  });
});

describe("removePersonality", () => {
  it("deletes a personality and clears it as active via the FK", async () => {
    const p = await createPersonality({ name: "Temp", prompt: "hi" }, trigger, ctx.db);
    await setActivePersonality(p.id, trigger, ctx.db);
    expect(await getActivePersonalityPrompt(ctx.db)).toBe("hi");

    await removePersonality(p.id, trigger, ctx.db);
    expect((await getPersonalitiesView(ctx.db)).personalities).toHaveLength(0);
    // The active selection was cleared automatically (on delete set null).
    expect((await getSettingsRecord(ctx.db))?.activePersonalityId).toBeNull();
    expect(await getActivePersonalityPrompt(ctx.db)).toBeNull();
  });

  it("rejects deleting an unknown id", async () => {
    await expect(removePersonality("nope", trigger, ctx.db)).rejects.toThrow(
      /unknown personality/i,
    );
  });
});

describe("trace recording", () => {
  it("records a trace for each mutation", async () => {
    const p = await createPersonality({ name: "Traced", prompt: "" }, trigger, ctx.db);
    await editPersonality(p.id, { prompt: "x" }, trigger, ctx.db);
    await setActivePersonality(p.id, trigger, ctx.db);
    await removePersonality(p.id, trigger, ctx.db);

    const { traces } = await listTraces({ feature: "personalities" });
    const actions = traces.map((t) => t.action).sort();
    expect(actions).toEqual(["create", "delete", "set-active", "update"]);
    expect(traces.every((t) => t.status === "success")).toBe(true);
  });
});
