import { describe, expect, it } from "vitest";

import {
  ACTION_CLAIM_ENFORCEMENT_DIRECTIVE,
  ACTION_NOT_TAKEN_REPLY,
  buildActionClaimMessages,
  parseActionClaimVerdict,
} from "./action-claim";

/**
 * The honesty gate's pure half. Everything the guard decides mechanically is
 * here: what the model is asked, and which of its answers are allowed to stop a
 * reply. The rule that matters most is the citation check — a verdict the model
 * cannot back with words that are really in the reply buys nothing.
 */

const answer = (claim: unknown, quote?: unknown) =>
  JSON.stringify({ claim, ...(quote === undefined ? {} : { quote }) });

describe("buildActionClaimMessages", () => {
  it("shows the request and the reply, and asks for JSON only", () => {
    const messages = buildActionClaimMessages({
      request: "  cancel the reminder  ",
      reply: "  Done, it's gone.  ",
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    const user = messages[1].content as string;
    expect(user).toContain("cancel the reminder");
    expect(user).toContain("Done, it's gone.");
    expect(user).toMatch(/only the JSON object/i);
  });

  it("tells the model an offer and an inability are not claims", () => {
    const system = buildActionClaimMessages({ request: "r", reply: "a" })[0].content as string;
    expect(system).toMatch(/offers to do something/i);
    expect(system).toMatch(/cannot do something/i);
    // The quote must come back in the reply's own words — a translated citation
    // could never be found in the reply and would silently disable the guard.
    expect(system).toMatch(/reply's own language/i);
    expect(system).toMatch(/[Dd]o not translate/i);
  });
});

describe("parseActionClaimVerdict", () => {
  const reply = "Removed from the record. It will not come up again.";

  it("stops a reply that claims the action happened and quotes it", () => {
    const verdict = parseActionClaimVerdict(answer("performed", "Removed from the record"), { reply });

    expect(verdict.claimsAction).toBe(true);
    expect(verdict.claim).toBe("performed");
    expect(verdict.quote).toBe("Removed from the record");
    expect(verdict.reason).toMatch(/no tool was called/);
  });

  it("stops a reply that promises the action too", () => {
    const promise = "I'll remind you tomorrow at nine.";
    const verdict = parseActionClaimVerdict(answer("promised", "I'll remind you tomorrow"), {
      reply: promise,
    });

    expect(verdict.claimsAction).toBe(true);
    expect(verdict.claim).toBe("promised");
  });

  it("passes an ordinary reply through", () => {
    const verdict = parseActionClaimVerdict(answer("none", null), { reply: "No idea, honestly." });

    expect(verdict.claimsAction).toBe(false);
    expect(verdict.claim).toBe("none");
    expect(verdict.quote).toBeNull();
  });

  it("reads a verdict the model wrapped in fences and prose", () => {
    const verdict = parseActionClaimVerdict(
      'Here you go:\n```json\n{"claim": "performed", "quote": "Removed from the record"}\n```',
      { reply },
    );

    expect(verdict.claimsAction).toBe(true);
  });

  it("matches the quote case-insensitively", () => {
    const verdict = parseActionClaimVerdict(answer("performed", "DONE — TASK DELETED"), {
      reply: "Done — task deleted.",
    });

    expect(verdict.claimsAction).toBe(true);
  });

  // Fails open, unlike the addressing analyzer: this guard exists to remove
  // lies, and must never become a new way for an honest turn to break.
  describe("abstains rather than blocking", () => {
    it("on an answer it cannot read", () => {
      const verdict = parseActionClaimVerdict("no idea what you mean", { reply });

      expect(verdict.claimsAction).toBe(false);
      expect(verdict.claim).toBeNull();
      expect(verdict.reason).toMatch(/unreadable/);
    });

    it("on a classification outside the enum", () => {
      const verdict = parseActionClaimVerdict(answer("maybe", "Removed"), { reply });

      expect(verdict.claimsAction).toBe(false);
      expect(verdict.claim).toBeNull();
    });

    it("when the model claims but quotes nothing", () => {
      const verdict = parseActionClaimVerdict(answer("performed", null), { reply });

      expect(verdict.claimsAction).toBe(false);
      expect(verdict.claim).toBe("performed");
      expect(verdict.reason).toMatch(/without quoting/);
    });

    // The failure this check exists for: a weak model stamping a verdict on the
    // general shape of a reply rather than on anything actually in it.
    it("when the quoted words are not in the reply", () => {
      const verdict = parseActionClaimVerdict(answer("performed", "task deleted successfully"), {
        reply,
      });

      expect(verdict.claimsAction).toBe(false);
      expect(verdict.quote).toBe("task deleted successfully");
      expect(verdict.reason).toMatch(/does not occur in the reply/);
    });
  });
});

describe("ACTION_CLAIM_ENFORCEMENT_DIRECTIVE", () => {
  it("names both allowed exits, including the honest one", () => {
    expect(ACTION_CLAIM_ENFORCEMENT_DIRECTIVE).toMatch(/called no tool/i);
    expect(ACTION_CLAIM_ENFORCEMENT_DIRECTIVE).toMatch(/will not be sent/i);
    expect(ACTION_CLAIM_ENFORCEMENT_DIRECTIVE).toMatch(/did not do it/i);
  });

  // The specific lever for the measured failure: the model skipped a *read*
  // because it had already guessed the read would come back empty.
  it("forbids answering from a lookup that was never run", () => {
    expect(ACTION_CLAIM_ENFORCEMENT_DIRECTIVE).toMatch(/read it with the tool that reads it/i);
    expect(ACTION_CLAIM_ENFORCEMENT_DIRECTIVE).toMatch(/repeated request/i);
  });
});

describe("ACTION_NOT_TAKEN_REPLY", () => {
  it("is labeled as the system speaking, not the persona", () => {
    expect(ACTION_NOT_TAKEN_REPLY).toContain("System:");
    expect(ACTION_NOT_TAKEN_REPLY).toMatch(/not sent/i);
  });
});
