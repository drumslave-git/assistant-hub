import { loadEnvConfig } from "@next/env";
import { afterAll, describe, expect, it } from "vitest";

import { closePool } from "@/db/pool";
import { getClassifierRuntime } from "@/features/settings/server/service";
import { runClassifier } from "@/server/llm/classifier";

import { buildTaskMatchMessages, parseTaskMatchVerdict, type MatchableTask } from "./matcher";

/**
 * Opt-in check of the `message`-task matcher against the REAL configured
 * classifier. Skipped unless `LLM_LIVE=1`.
 *
 * The prompt this exercises is the one piece of the feature no unit test can
 * judge: `matcher.test.ts` pins what is *asked*, and this pins what a real small
 * model *answers*. It exists because the wording is load-bearing in both
 * directions and moves them independently — a phrasing that finally made a
 * person-only task fire also made a targeted task with a content condition fire
 * on every message that person sent (6 runs out of 6, 2026-08-13). Both
 * directions are asserted here, and every case is run several times, because one
 * green answer from a 26B model is noise.
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tasks/server/live-matcher`
 */

loadEnvConfig(process.cwd());

const LIVE = process.env.LLM_LIVE === "1";

/** One green answer proves nothing; a small model has to be asked repeatedly. */
const RUNS = 6;

/** Synthetic people, in the label form the runtime builds from the roster. */
const ANN = "Ann K (@ann)";
const SAM = "Sam T (@samt)";

/** A task whose only condition is who is speaking — the shape that never fired. */
const PERSON_TASK: MatchableTask = {
  id: "person",
  instruction: "tell them what a great job they are doing",
  targetLabels: [ANN],
};
/** The same shape, but also naming something that has to be in the message. */
const PERSON_AND_CONTENT_TASK: MatchableTask = {
  id: "person-content",
  instruction: "download any video link they post",
  targetLabels: [ANN],
};
/** An ordinary task for everybody, conditioned only on the words. */
const CONTENT_TASK: MatchableTask = {
  id: "content",
  instruction: "When someone posts a video link, download it.",
};

const CHATTER = "morning all, anyone up for coffee before the standup?";
const WITH_LINK = "look at this https://example.com/clip/42 lol";

afterAll(async () => {
  await closePool();
});

/** Run one matcher prompt `RUNS` times; returns the matched ids of each run. */
async function verdicts(
  tasks: MatchableTask[],
  text: string,
  senderLabel: string,
): Promise<string[][]> {
  const runtime = await getClassifierRuntime();
  if (!runtime) throw new Error("no classifier runtime is configured in settings");
  const out: string[][] = [];
  for (let i = 0; i < RUNS; i++) {
    const result = await runClassifier(
      runtime,
      buildTaskMatchMessages({ tasks, text, chatType: "supergroup", senderLabel }),
    );
    out.push(parseTaskMatchVerdict(result.content, { tasks, text }).matchedIds);
  }
  return out;
}

describe.skipIf(!LIVE)("live task matcher", () => {
  it("fires a person-only task for the person it names", async () => {
    const runs = await verdicts([PERSON_TASK], CHATTER, ANN);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.includes("person")),
    );
  }, 240_000);

  it("never fires that task for anybody else", async () => {
    const runs = await verdicts([PERSON_TASK], CHATTER, SAM);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.length === 0),
    );
  }, 240_000);

  it("keeps a targeted task's content condition — right person, nothing to act on", async () => {
    // The regression guard. Naming a person must not become a licence to fire on
    // everything they say when the task also names something to look for.
    const runs = await verdicts([PERSON_AND_CONTENT_TASK], CHATTER, ANN);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.length === 0),
    );
  }, 240_000);

  it("fires a targeted task when the right person posts what it asks for", async () => {
    const runs = await verdicts([PERSON_AND_CONTENT_TASK], WITH_LINK, ANN);
    expect(runs, JSON.stringify(runs)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.includes("person-content")),
    );
  }, 240_000);

  it("leaves an untargeted content task exactly as it was", async () => {
    const quiet = await verdicts([CONTENT_TASK], CHATTER, SAM);
    const triggered = await verdicts([CONTENT_TASK], WITH_LINK, SAM);
    expect(quiet, JSON.stringify(quiet)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.length === 0),
    );
    expect(triggered, JSON.stringify(triggered)).toSatisfy((r: string[][]) =>
      r.every((ids) => ids.includes("content")),
    );
  }, 240_000);
});
