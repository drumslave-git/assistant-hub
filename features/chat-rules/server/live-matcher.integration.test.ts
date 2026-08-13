import { loadEnvConfig } from "@next/env";
import { afterAll, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { getClassifierRuntime } from "@/features/settings/server/service";
import { runClassifier } from "@/server/llm/classifier";

import { buildRuleMatchMessages, parseRuleMatchVerdict, type MatchableRule } from "./matcher";

/**
 * Opt-in check of the `always`-rule matcher against the REAL configured
 * classifier. Skipped unless `LLM_LIVE=1`.
 *
 * The prompt this exercises is the one piece of the feature no unit test can
 * judge: `matcher.test.ts` pins what is *asked*, and this pins what a real small
 * model *answers*. It exists because the wording is load-bearing in both
 * directions and moves them independently — a phrasing that finally made a
 * person-only rule fire also made a targeted rule with a content condition fire
 * on every message that person sent (6 runs out of 6, 2026-08-13). Both
 * directions are asserted here, and every case is run several times, because one
 * green answer from a 26B model is noise.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- chat-rules/server/live-matcher`
 */

loadEnvConfig(process.cwd());

const LIVE = process.env.LLM_LIVE === "1";

/** One green answer proves nothing; a small model has to be asked repeatedly. */
const RUNS = 6;

/** Synthetic people, in the label form the runtime builds from the roster. */
const ANN = "Ann K (@ann)";
const SAM = "Sam T (@samt)";

/** A rule whose only condition is who is speaking — the shape that never fired. */
const PERSON_RULE: MatchableRule = {
  id: "person",
  text: "tell them what a great job they are doing",
  targetLabels: [ANN],
};
/** The same shape, but also naming something that has to be in the message. */
const PERSON_AND_CONTENT_RULE: MatchableRule = {
  id: "person-content",
  text: "download any video link they post",
  targetLabels: [ANN],
};
/** An ordinary rule for everybody, conditioned only on the words. */
const CONTENT_RULE: MatchableRule = {
  id: "content",
  text: "When someone posts a video link, download it.",
};

const CHATTER = "morning all, anyone up for coffee before the standup?";
const WITH_LINK = "look at this https://example.com/clip/42 lol";

afterAll(async () => {
  await closePool();
});

/** Run one matcher prompt `RUNS` times; returns the matched ids of each run. */
async function verdicts(
  rules: MatchableRule[],
  text: string,
  senderLabel: string,
): Promise<string[][]> {
  const runtime = await getClassifierRuntime();
  if (!runtime) throw new Error("no classifier runtime is configured in settings");
  const out: string[][] = [];
  for (let i = 0; i < RUNS; i++) {
    const result = await runClassifier(
      runtime,
      buildRuleMatchMessages({ rules, text, chatType: "supergroup", senderLabel }),
    );
    out.push(parseRuleMatchVerdict(result.content, { rules, text }).matchedIds);
  }
  return out;
}

describe.skipIf(!LIVE)("live rule matcher", () => {
  it("fires a person-only rule for the person it names", async () => {
    const runs = await verdicts([PERSON_RULE], CHATTER, ANN);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.includes("person")),
    );
  }, 240_000);

  it("never fires that rule for anybody else", async () => {
    const runs = await verdicts([PERSON_RULE], CHATTER, SAM);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.length === 0),
    );
  }, 240_000);

  it("keeps a targeted rule's content condition — right person, nothing to act on", async () => {
    // The regression guard. Naming a person must not become a licence to fire on
    // everything they say when the rule also names something to look for.
    const runs = await verdicts([PERSON_AND_CONTENT_RULE], CHATTER, ANN);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.length === 0),
    );
  }, 240_000);

  it("fires a targeted rule when the right person posts what it asks for", async () => {
    const runs = await verdicts([PERSON_AND_CONTENT_RULE], WITH_LINK, ANN);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.includes("person-content")),
    );
  }, 240_000);

  it("leaves an untargeted content rule exactly as it was", async () => {
    const quiet = await verdicts([CONTENT_RULE], CHATTER, SAM);
    const triggered = await verdicts([CONTENT_RULE], WITH_LINK, SAM);
    expect(quiet, JSON.stringify(quiet)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.length === 0),
    );
    expect(triggered, JSON.stringify(triggered)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.includes("content")),
    );
  }, 240_000);
});
