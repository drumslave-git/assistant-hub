import type { UserMatchCandidate } from "@/features/known-users/match";

/**
 * Reusable known-user match candidates for the reference-matching tests. These
 * are stable named identities referenced across multiple assertions; per-test
 * one-off users stay inline where the literal documents the scenario.
 */
export const aliceCandidate: UserMatchCandidate = {
  username: "alice",
  firstName: "Alice",
  lastName: "Anderson",
  aliases: ["Boss"],
};

export const bobCandidate: UserMatchCandidate = {
  username: "bobby",
  firstName: "Bob",
  lastName: null,
  aliases: [],
};

/** A second "Alice" — shares the first name with {@link aliceCandidate}. */
export const aliceBrownCandidate: UserMatchCandidate = {
  username: "alicia",
  firstName: "Alice",
  lastName: "Brown",
  aliases: [],
};
