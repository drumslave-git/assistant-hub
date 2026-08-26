import { describe, expect, it } from "vitest";

import {
  MAX_MEMBERS,
  MIN_MEMBERS,
  createPersonLinkSchema,
  updatePersonLinkSchema,
} from "./schema";

/**
 * The person-links validation contract: what the operator may declare. The
 * bounds are the feature's meaning — a link of one identity says nothing, and
 * an identity is named by a scoped ref or not at all.
 */

const ALICE = "tg:user:1";
const ALICE_WEB = "chat:user:2";

describe("createPersonLinkSchema", () => {
  it("accepts two identities and trims the note", () => {
    const parsed = createPersonLinkSchema.parse({
      members: [ALICE, ALICE_WEB],
      note: "  same person  ",
    });
    expect(parsed).toEqual({ members: [ALICE, ALICE_WEB], note: "same person" });
  });

  it("clears a blank note to null and defaults a missing one", () => {
    expect(createPersonLinkSchema.parse({ members: [ALICE, ALICE_WEB], note: "   " }).note).toBeNull();
    expect(createPersonLinkSchema.parse({ members: [ALICE, ALICE_WEB] }).note).toBe("");
  });

  it("collapses duplicate identities before counting them", () => {
    expect(
      createPersonLinkSchema.parse({ members: [ALICE, ALICE_WEB, ALICE] }).members,
    ).toEqual([ALICE, ALICE_WEB]);

    // …so a repeated identity cannot fake a second one.
    expect(() => createPersonLinkSchema.parse({ members: [ALICE, ALICE] })).toThrow(
      new RegExp(`at least ${MIN_MEMBERS}`),
    );
  });

  it("rejects a link of one identity", () => {
    expect(() => createPersonLinkSchema.parse({ members: [ALICE] })).toThrow();
  });

  it("rejects an identity that is not a scoped ref", () => {
    expect(() => createPersonLinkSchema.parse({ members: [ALICE, "12345"] })).toThrow();
  });

  it("bounds the number of identities", () => {
    const many = Array.from({ length: MAX_MEMBERS + 1 }, (_, i) => `tg:user:${i}`);
    expect(() => createPersonLinkSchema.parse({ members: many })).toThrow(
      new RegExp(`At most ${MAX_MEMBERS}`),
    );
  });
});

describe("updatePersonLinkSchema", () => {
  it("takes the note or the identities, one per call", () => {
    expect(updatePersonLinkSchema.parse({ note: "work + personal" })).toEqual({
      note: "work + personal",
    });
    expect(updatePersonLinkSchema.parse({ members: [ALICE, ALICE_WEB] })).toEqual({
      members: [ALICE, ALICE_WEB],
    });
  });

  it("rejects a body carrying neither", () => {
    expect(() => updatePersonLinkSchema.parse({})).toThrow();
  });
});
