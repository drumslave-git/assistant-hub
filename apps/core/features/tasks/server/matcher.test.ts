import { describe, expect, it } from "vitest";

import {
  buildTaskMatchMessages,
  parseTaskMatchVerdict,
  TASK_MATCH_SYSTEM_PROMPT,
} from "./matcher";

/**
 * The `message`-task matcher: the only path by which the bot acts on a message
 * nobody sent it, so every test here is about *not* answering unless the model
 * earned it — an unknown task number, a missing quote, or an invented quote all
 * fail closed, exactly like the addressing analyzer's citation check.
 */

const TASKS = [
  { id: "t1", instruction: "When someone posts a video link, download it." },
  { id: "t2", instruction: "When someone says good morning, greet them." },
];

const MESSAGE = "look at this https://example.com/clip/42 lol";

function parse(content: string, text = MESSAGE) {
  return parseTaskMatchVerdict(content, { tasks: TASKS, text });
}

describe("buildTaskMatchMessages", () => {
  it("offers the tasks numbered from 1, with the message and the chat type", () => {
    const [system, user] = buildTaskMatchMessages({
      tasks: TASKS,
      text: MESSAGE,
      chatType: "supergroup",
    });
    expect(system.role).toBe("system");
    expect(user.content).toContain("1. When someone posts a video link, download it.");
    expect(user.content).toContain("2. When someone says good morning, greet them.");
    expect(user.content).toContain(MESSAGE);
    expect(user.content).toContain("supergroup");
    // No audience prefix and no sender line for tasks that apply to everyone.
    expect(user.content).not.toContain("if message from");
    expect(user.content).toContain("Message:");
  });

  /**
   * A task limited to particular people can have *no* condition on the words at
   * all — "for this person, always do X". Asked whether the message contains
   * what such a rule describes, the model rightly answers no, because the rule
   * describes nothing the message could contain (trace `c08283a8…`). Both names
   * are what turn it into a question that can be answered.
   */
  it("prefixes a targeted task with its audience and names the sender", () => {
    const [, user] = buildTaskMatchMessages({
      tasks: [{ id: "t1", instruction: "tell them they did well.", targetLabels: ["Ada L (@ada)"] }],
      text: MESSAGE,
      chatType: "supergroup",
      senderLabel: "Ada L (@ada)",
    });

    expect(user.content).toContain("1. if message from Ada L (@ada): tell them they did well.");
    expect(user.content).toContain("Message from Ada L (@ada):");
  });

  it("names every person a task was limited to", () => {
    const [, user] = buildTaskMatchMessages({
      tasks: [{ id: "t1", instruction: "greet them.", targetLabels: ["Ada", "Bob"] }],
      text: MESSAGE,
      chatType: "supergroup",
      senderLabel: "Bob",
    });

    expect(user.content).toContain("1. if message from Ada or Bob: greet them.");
  });

  it("leaves the message unlabelled when the sender is unknown", () => {
    const [, user] = buildTaskMatchMessages({
      tasks: TASKS,
      text: MESSAGE,
      chatType: "supergroup",
      senderLabel: null,
    });

    expect(user.content).toContain("Message:");
    expect(user.content).not.toContain("Message from");
  });
});

/**
 * The prompt's shape is pinned because it is load-bearing in *two* directions,
 * and the wording moves them independently: a phrasing that finally made a
 * person-only task fire also made a targeted task with a content condition fire
 * on every message that person sent (6 live runs out of 6, 2026-08-13). What a
 * real model does with it is checked in `live-matcher.integration.test.ts`;
 * this only guards the structure that was arrived at.
 */
describe("TASK_MATCH_SYSTEM_PROMPT", () => {
  it("sends the who-is-speaking condition to the sender line, not the message text", () => {
    expect(TASK_MATCH_SYSTEM_PROMPT).toContain("if message from <person>");
    expect(TASK_MATCH_SYSTEM_PROMPT).toMatch(/compare the two names/i);
    expect(TASK_MATCH_SYSTEM_PROMPT).toMatch(/never look for the person's name inside the message/i);
  });

  it("keeps naming a person from excusing a task from its content condition", () => {
    // Both branches of step 2 have to be spelled out: without the first, a
    // targeted task fires on everything its person says.
    expect(TASK_MATCH_SYSTEM_PROMPT).toMatch(/names something that has to be in the message/i);
    expect(TASK_MATCH_SYSTEM_PROMPT).toMatch(/names nothing that has to be in the message/i);
    // The worked contrast, which is what a small model actually generalizes from.
    expect(TASK_MATCH_SYSTEM_PROMPT).toContain("download any video link she posts");
  });

  /**
   * The citation guard is unchanged — a match still has to quote real text — so
   * a task that asks nothing of the words needs somewhere to point. The message
   * itself is the honest answer, and it survives the guard by construction.
   */
  it("tells the model what to quote when a task asks nothing of the message", () => {
    expect(TASK_MATCH_SYSTEM_PROMPT).toMatch(/copy the message itself into "quote"/i);
  });
});

describe("parseTaskMatchVerdict", () => {
  it("accepts a task whose quote occurs in the message", () => {
    const verdict = parse('{"matched":[{"rule":1,"quote":"https://example.com/clip/42"}]}');
    expect(verdict.matchedIds).toEqual(["t1"]);
  });

  it("reads an empty list as the ordinary no-match answer", () => {
    const verdict = parse('{"matched":[]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toBe("no rule triggered");
  });

  it("treats an unreadable answer as no match", () => {
    expect(parse("I think rule 1 applies!").matchedIds).toEqual([]);
    expect(parse("").matchedIds).toEqual([]);
    expect(parse('{"other":true}').matchedIds).toEqual([]);
  });

  it("rejects a task number that was never offered", () => {
    const verdict = parse('{"matched":[{"rule":7,"quote":"lol"}]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toContain("never offered");
  });

  it("rejects a match claimed without a quote", () => {
    const verdict = parse('{"matched":[{"rule":1}]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toContain("without quoting");
  });

  it("rejects a quote the message does not contain", () => {
    const verdict = parse('{"matched":[{"rule":1,"quote":"https://other.example/nope"}]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toContain("does not occur");
  });

  it("matches the quote case-insensitively", () => {
    expect(parse('{"matched":[{"rule":1,"quote":"HTTPS://EXAMPLE.COM/CLIP/42"}]}').matchedIds).toEqual([
      "t1",
    ]);
  });

  it("keeps the surviving tasks when only some claims check out", () => {
    const verdict = parse(
      '{"matched":[{"rule":1,"quote":"https://example.com/clip/42"},{"rule":2,"quote":"good morning"}]}',
    );
    expect(verdict.matchedIds).toEqual(["t1"]);
    expect(verdict.reason).toContain("rejected");
  });

  it("does not report the same task twice", () => {
    const verdict = parse('{"matched":[{"rule":1,"quote":"lol"},{"rule":1,"quote":"look"}]}');
    expect(verdict.matchedIds).toEqual(["t1"]);
  });

  it("reads a fenced answer the model wrapped in prose", () => {
    const verdict = parse('Sure!\n```json\n{"matched":[{"rule":1,"quote":"lol"}]}\n```');
    expect(verdict.matchedIds).toEqual(["t1"]);
  });

  it("accepts the whole message as the quote, which is what a person-only task cites", () => {
    // The guard is mechanical and unchanged: the message occurs in itself, so a
    // task conditioned only on who is speaking passes without an exemption.
    const verdict = parse(`{"matched":[{"rule":1,"quote":${JSON.stringify(MESSAGE)}}]}`);
    expect(verdict.matchedIds).toEqual(["t1"]);
  });
});
