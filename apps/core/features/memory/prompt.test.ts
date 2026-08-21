import { describe, expect, it } from "vitest";

import {
  buildGeneralMergeRequest,
  buildUserMergeRequest,
  GENERAL_MERGE_PROMPT,
  parseMergedDocument,
} from "./prompt";

/**
 * The nightly job's whole decision surface is pure, so its riskiest behavior —
 * what happens when the model returns something wrong — is testable without a
 * model or a database. The parser is written to fail *closed*: an unusable
 * response must leave memory untouched, never destroy or corrupt it. Both scopes
 * merge documents now, so both go through {@link parseMergedDocument}.
 */

describe("buildUserMergeRequest", () => {
  it("names the person and shows the existing document with the incoming notes", () => {
    const request = buildUserMergeRequest({
      label: "Ada",
      existing: ["Lives in Porto.", "Prefers short answers."],
      incoming: ["Moved to Lisbon."],
    });
    expect(request).toContain("Ada");
    expect(request).toContain("Lives in Porto.");
    expect(request).toContain("Prefers short answers.");
    expect(request).toContain("- Moved to Lisbon.");
  });

  it("says so explicitly when the person has no memory yet", () => {
    const request = buildUserMergeRequest({ label: "Ada", existing: [], incoming: ["Likes rye."] });
    expect(request).toContain("(nothing known yet)");
  });
});

describe("parseMergedDocument", () => {
  it("returns the merged facts as lines", () => {
    const parsed = parseMergedDocument('{"memory": "Lives in Lisbon.\\nPrefers short answers."}');
    expect(parsed).toEqual(["Lives in Lisbon.", "Prefers short answers."]);
  });

  it("tolerates code fences and prose around the JSON", () => {
    const parsed = parseMergedDocument('Sure!\n```json\n{"memory": "Likes rye bread."}\n```');
    expect(parsed).toEqual(["Likes rye bread."]);
  });

  it("strips bullet characters the model adds despite being told not to", () => {
    const parsed = parseMergedDocument('{"memory": "- Likes rye.\\n* Dislikes small talk."}');
    expect(parsed).toEqual(["Likes rye.", "Dislikes small talk."]);
  });

  it("returns nothing for an unparseable response, so the caller leaves memory alone", () => {
    expect(parseMergedDocument("I could not do that.")).toEqual([]);
    expect(parseMergedDocument('{"wrong_key": "Likes rye."}')).toEqual([]);
  });

  it('treats a literal "none" as no document rather than storing the word', () => {
    expect(parseMergedDocument('{"memory": "none"}')).toEqual([]);
    expect(parseMergedDocument('{"memory": ""}')).toEqual([]);
  });
});

describe("buildGeneralMergeRequest", () => {
  it("shows the existing document with the incoming notes", () => {
    const request = buildGeneralMergeRequest({
      existing: ["Standup is at 09:30.", "Deploys happen on Thursdays."],
      incoming: ["Standup moved to 10:00."],
    });
    expect(request).toContain("Standup is at 09:30.");
    expect(request).toContain("Deploys happen on Thursdays.");
    expect(request).toContain("- Standup moved to 10:00.");
  });

  it("says so explicitly when nothing is stored yet", () => {
    const request = buildGeneralMergeRequest({ existing: [], incoming: ["Standup is at 10:00."] });
    expect(request).toContain("(nothing known yet)");
  });

  /**
   * The general document, unlike a person's, has no subject of its own — it is
   * read with no conversation around it, so a line saying "he moved to Lisbon"
   * would be unattributable forever.
   */
  it("instructs that every line names its own subject", () => {
    expect(GENERAL_MERGE_PROMPT).toContain("name its own subject");
  });

  /**
   * The merge used to be told that biography "is a line to drop", which threw away
   * facts about people the bot cannot file under an id — the only place those can
   * live. Placement is decided at the gate now (see `checkGeneralNoteSubject`), so
   * by the time a fact reaches this prompt it has already been established that it
   * belongs here.
   */
  it("keeps facts about people rather than dropping them as biography", () => {
    expect(GENERAL_MERGE_PROMPT).toContain("Keep every named fact");
    expect(GENERAL_MERGE_PROMPT).not.toContain("is a line to drop");
  });

  /** The guard that replaced the ban: no identity model, so never invent one. */
  it("forbids merging two people into one subject", () => {
    expect(GENERAL_MERGE_PROMPT).toContain("never conclude that two names are the same person");
  });
});
