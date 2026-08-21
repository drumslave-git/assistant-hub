/**
 * Prompt building + strict-JSON parsing for the analytics insight job. Pure and
 * dependency-free so the parsers (the fail-closed boundary) are unit-testable
 * without an LLM.
 */

import { clampMoodScore, moodLabelForScore } from "../mood";

/** Cap on transcript characters fed to one hour-insight call, to bound tokens. */
const TRANSCRIPT_CHAR_CAP = 12_000;

/**
 * Words that describe the *shape* of a conversation rather than its subject.
 *
 * A chat full of shared URLs is not a chat *about* links, but a model reading the
 * raw transcript will happily answer "links" because that is what it literally saw
 * most of. Same for "message", "chat", "question" — all true, all useless as the
 * word of the period. Enforced twice: asked for in the prompt, and checked here, so
 * a model that ignores the instruction still cannot produce one.
 */
const STRUCTURAL_WORDS = new Set([
  "link",
  "links",
  "url",
  "urls",
  "http",
  "https",
  "message",
  "messages",
  "chat",
  "chats",
  "conversation",
  "bot",
  "user",
  "question",
  "questions",
  "answer",
  "answers",
  "reply",
  "replies",
  "text",
  "word",
  "words",
  "topic",
  "topics",
  "discussion",
  "miscellaneous",
  "various",
  "general",
  "none",
  "n/a",
]);

export const HOUR_INSIGHT_PROMPT = [
  "You are an analytics assistant. You read ONE hour of one chat's conversation and",
  "describe it as a strict JSON object with exactly these fields:",
  '- "moodScore": integer 0–100 (0 = very negative/hostile, 50 = neutral, 100 = very positive/warm),',
  "  judged from the human participants' tone.",
  '- "moodLabel": 1–2 word mood (e.g. "positive", "tense", "neutral").',
  '- "moodSummary": one short sentence explaining the mood.',
  '- "topTopic": the single most-discussed topic, as a short CONCRETE noun phrase naming',
  "  the actual subject matter. Never an umbrella phrase like \"miscellaneous topics\",",
  '  "various subjects", "general chat" or "several things" — if the hour ranged widely,',
  "  name the one subject that took the most of it.",
  '- "word": ONE standout word — the most emblematic single word of what was DISCUSSED.',
  "  It must be a content word about the subject, never a word describing the medium",
  '  itself ("links", "messages", "chat", "question", "url").',
  "Respond with ONLY the JSON object — no prose, no markdown, no code fences.",
].join("\n");

export const PERIOD_ROLLUP_PROMPT = [
  "You are an analytics assistant. You are given a numbered list of sub-periods, each",
  "with its own top topic and standout word. Choose which ones best characterize the",
  "whole period and return a strict JSON object with exactly these fields:",
  '- "topicIndex": the number of the entry whose topic best represents the whole period.',
  '- "wordIndex": the number of the entry whose word best represents the whole period.',
  "You MUST choose from the numbered entries. Do not invent a new topic or word, do not",
  "summarize them into an umbrella phrase, and do not return anything but these two numbers.",
  "Prefer entries that carried more messages when they are otherwise comparable.",
  "Respond with ONLY the JSON object — no prose, no markdown, no code fences.",
].join("\n");

/** Render an hour's messages as a bounded, role-labelled transcript. */
export function formatTranscript(
  messages: { role: "user" | "assistant"; content: string }[],
): string {
  const lines = messages
    .filter((m) => m.content.trim().length > 0)
    .map((m) => `${m.role === "assistant" ? "Bot" : "User"}: ${m.content.replace(/\s+/g, " ").trim()}`);
  let text = lines.join("\n");
  if (text.length > TRANSCRIPT_CHAR_CAP) {
    text = `…\n${text.slice(text.length - TRANSCRIPT_CHAR_CAP)}`;
  }
  return text;
}

/** The user message for one hour-insight call. */
export function buildHourInsightRequest(input: { transcript: string; topics: string[] }): string {
  const parts = [`Conversation (one hour):\n${input.transcript}`];
  if (input.topics.length > 0) {
    parts.push(
      `Already-identified topics for the day this hour belongs to:\n${input.topics.map((t) => `- ${t}`).join("\n")}`,
    );
  }
  parts.push("Return the JSON object now.");
  return parts.join("\n\n");
}

/** One sub-period offered to a roll-up call. */
export interface RollupChild {
  bucket: string;
  moodLabel: string;
  topTopic: string;
  word: string;
  messageCount: number;
}

/** The user message for one period roll-up call — a numbered menu to choose from. */
export function buildPeriodRollupRequest(input: { label: string; children: RollupChild[] }): string {
  const lines = input.children.map(
    (c, i) =>
      `${i + 1}. ${c.bucket} — mood ${c.moodLabel} — topic: ${c.topTopic} — word: ${c.word} (${c.messageCount} msgs)`,
  );
  return [
    `Period: ${input.label}. Sub-periods (${input.children.length}):`,
    lines.join("\n"),
    "Return the JSON object now.",
  ].join("\n\n");
}

/** Extract the first top-level JSON object from a model response, or null. */
function extractJsonObject(content: string): Record<string, unknown> | null {
  const cleaned = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The fallback "word" for a topic: its first word that is not itself structural.
 *
 * Taking the plain first word defeated the guard it exists to serve — a topic like
 * "bot project" fell back to "bot", which is exactly the kind of word the guard
 * rejected in the first place. Scanning past those yields "project", the word a
 * reader actually wants. If every word is structural there is nothing better to say
 * than the topic itself.
 */
function fallbackWord(topic: string): string {
  const words = topic.split(/\s+/).filter((w) => w.length > 0);
  return words.find((w) => !isStructuralWord(w)) ?? words[0] ?? topic;
}

/** Whether a candidate word describes the medium rather than the subject. */
export function isStructuralWord(word: string): boolean {
  return STRUCTURAL_WORDS.has(word.trim().toLowerCase().replace(/[.,!?;:"']/g, ""));
}

export interface HourInsight {
  moodScore: number;
  moodLabel: string;
  moodSummary: string;
  topTopic: string;
  word: string;
}

/**
 * Parse an hour-insight response. Fails closed: returns null unless a topic and a
 * usable mood score are present, so a garbled response leaves the hour unscored and
 * owed to the next run.
 *
 * A structural `word` is *corrected* rather than rejected — falling back to the
 * topic's first word — because rejecting it would leave the hour permanently owed
 * and re-billed every night for a model that keeps answering the same way.
 */
export function parseHourInsight(content: string): HourInsight | null {
  const obj = extractJsonObject(content);
  if (!obj) return null;
  const topTopic = asString(obj.topTopic);
  const rawScore = typeof obj.moodScore === "number" ? obj.moodScore : Number(obj.moodScore);
  if (!topTopic || !Number.isFinite(rawScore)) return null;
  const moodScore = clampMoodScore(rawScore);
  const rawWord = asString(obj.word);
  const word = rawWord && !isStructuralWord(rawWord) ? rawWord : fallbackWord(topTopic);
  return {
    moodScore,
    moodLabel: asString(obj.moodLabel) || moodLabelForScore(moodScore),
    moodSummary: asString(obj.moodSummary),
    topTopic,
    word,
  };
}

export interface RollupChoice {
  /** 0-based index into the children offered. */
  topicIndex: number;
  wordIndex: number;
}

function asIndex(value: unknown, count: number): number | null {
  const n = typeof value === "number" ? value : Number(asString(value));
  if (!Number.isInteger(n)) return null;
  // The prompt numbers from 1; anything outside the menu is not a choice.
  return n >= 1 && n <= count ? n - 1 : null;
}

/**
 * Parse a roll-up response into indices back into the children that were offered.
 *
 * Indices rather than free text is the whole point: it makes "miscellaneous topics"
 * *unrepresentable*. The model can only ever point at a topic some real sub-period
 * actually had, so the card shows a top topic instead of a summary of topics.
 *
 * Returns null when neither index is usable; the caller then falls back
 * deterministically rather than failing the period.
 */
export function parseRollupChoice(content: string, childCount: number): RollupChoice | null {
  if (childCount <= 0) return null;
  const obj = extractJsonObject(content);
  if (!obj) return null;
  const topicIndex = asIndex(obj.topicIndex, childCount);
  const wordIndex = asIndex(obj.wordIndex, childCount);
  if (topicIndex === null && wordIndex === null) return null;
  // One usable index is enough — the other falls back to it rather than discarding
  // a good answer because its partner was malformed.
  return {
    topicIndex: topicIndex ?? (wordIndex as number),
    wordIndex: wordIndex ?? (topicIndex as number),
  };
}
