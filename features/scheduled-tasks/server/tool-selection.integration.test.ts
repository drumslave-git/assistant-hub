import { describe, it } from "vitest";

import {
  expectToolCalled,
  LLM_LIVE,
  runToolSelection,
  TOOL_SELECTION_TIMEOUT,
  useLiveLlm,
} from "@/test/tool-selection";

/**
 * Opt-in live tool-selection coverage for the scheduled-tasks MCP tools. Skipped
 * unless `LLM_LIVE=1`. Tools are never executed — each call is recorded and answered
 * with a canned result (see {@link runToolSelection}). The canned `tasks_list` result
 * carries a task id, so the update/delete flows can complete the natural two-step
 * (list to find the task, then act on it).
 *
 * Run: `LLM_LIVE=1 npm run test:integration -- tool-selection`
 */
describe.skipIf(!LLM_LIVE)("scheduled-tasks MCP tool selection (live)", () => {
  useLiveLlm();

  it(
    "creates a scheduled task from a reminder request",
    async () => {
      const run = await runToolSelection({
        userText: "Set up a reminder every day at 9am to drink water.",
      });
      expectToolCalled(run, "tasks_create");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "creates a one-off task from a relative-time reminder ('in 5 minutes')",
    async () => {
      // Regression: without a current-time context the model cannot resolve "in 5m"
      // and gives up without creating a task (real trace, 2026-07-14).
      const run = await runToolSelection({
        userText: "remind me to stand up in 5m",
      });
      expectToolCalled(run, "tasks_create");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "creates a daily task from a third-person, in-character joke request",
    async () => {
      // Regression: a recurring request phrased as a joke about the bot's persona
      // ("let <persona> roast everyone once a day") made the model role-play the
      // acknowledgement — "adding it to the schedule" — without calling any tool
      // (real group-chat trace, 2026-07-27; the original was the same phrasing in
      // idiomatic Ukrainian, which the configured model additionally fails on —
      // see the tracker entry). The base prompt's honesty rules now bind action
      // claims to tool calls even in character; this pins that a persona-mode gag
      // request still schedules for real. The persona deliberately includes the
      // "avoid 'I will…' templates" line that helped mask the original bluff.
      const run = await runToolSelection({
        personalityPrompt:
          "You are Boris. You are a distinct personality: sharp, cynical, dry, sarcastic, " +
          "impatient with stupidity. Reply concisely, with attitude. Stay in character. " +
          'Avoid all forms of boilerplate assistance (templates like "I will...").',
        systemContext: [
          'You are chatting in the Telegram group "Testers". Known participants: ' +
            "Denys (@denys_qa), Olha (@olha_dev).",
        ],
        userText:
          "[#101] Denys (@denys_qa): let Boris send everyone to the infantry once a day, rudely",
      });
      expectToolCalled(run, "tasks_create");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "lists scheduled tasks when asked what's scheduled",
    async () => {
      const run = await runToolSelection({
        userText: "What reminders do I currently have scheduled?",
      });
      expectToolCalled(run, "tasks_list");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "updates a scheduled task (list to find it, then change it)",
    async () => {
      const run = await runToolSelection({
        userText: "Change my daily water reminder to 8am instead of 9am.",
      });
      expectToolCalled(run, "tasks_update");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "deletes a scheduled task when asked to cancel it",
    async () => {
      const run = await runToolSelection({
        userText: "Cancel my daily water reminder, I don't need it anymore.",
      });
      expectToolCalled(run, "tasks_delete");
    },
    TOOL_SELECTION_TIMEOUT,
  );

  it(
    "gets one scheduled task's details by id",
    async () => {
      const run = await runToolSelection({
        priorTurns: [
          { role: "assistant", content: "You have one task — task_demo_1: daily at 09:00." },
        ],
        userText: "Show me the full details of the scheduled task task_demo_1.",
      });
      expectToolCalled(run, "tasks_get");
    },
    TOOL_SELECTION_TIMEOUT,
  );
});
