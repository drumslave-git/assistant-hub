import "server-only";

import { getStoreDb, type StoreDb } from "@/server/store/db";
import type { AddressingExclusion } from "@/features/bot-messaging/exclusions";
import {
  deleteAddressingExclusion,
  listAddressingExclusions,
} from "@/features/bot-messaging/server/exclusions-repository";
import { formatKnownUserLabel } from "@/features/known-users/format";
import { getKnownUsersByIds } from "@/features/known-users/server/repository";
import { getLlmRuntime } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { publishEvent } from "@/server/realtime/hub";
import { startTrace } from "@/server/trace";
import { formatPreferencesContext } from "../format";
import { normalizeModelName } from "../model-name";
import type { CommunicationPreference, SelfCorrection, UserFeedback } from "../types";
import { getReplyTrace } from "./exchange";
import { resolveFeedbackPorts, type SourceMessagePort } from "./feedback-store";
import {
  getLatestCorrection,
  getLatestPreference,
  listLatestPreferences,
} from "./repository";

/**
 * Self-improvement domain service — the prompt-injection reads (latest
 * self-correction, latest per-user preferences) and the dashboard view. The
 * collection flows (reaction → menu → answer) live in the owning source app
 * since the split; completions arrive as `feedback.recorded` bus events
 * (see `recorded-consumer.ts`), and the daily incorporation job lives in
 * `analyze.ts`.
 */

const FEEDBACK_FEATURE = FEATURES["user-feedback"];

/**
 * Resolve the clean model name that generated a bot reply: the reply trace's
 * `llm_response` usage records the provider-reported model; fall back to the
 * currently configured model. Informational only — never blocks the flow.
 */
export async function resolveReplyModel(
  messages: SourceMessagePort,
  chatId: string,
  telegramMessageId: number,
): Promise<string> {
  const trace = await getReplyTrace(messages, chatId, telegramMessageId);
  const model = trace?.events.find((e) => e.usage?.model)?.usage?.model;
  if (model) return normalizeModelName(model);
  const runtime = await getLlmRuntime().catch(() => null);
  return normalizeModelName(runtime?.model);
}


/**
 * The latest global self-correction text for the system prompt, or null when
 * none exists yet. Read fresh per reply (like the personality).
 */
export async function getLatestSelfCorrectionPrompt(db: StoreDb = getStoreDb()): Promise<string | null> {
  const latest = await getLatestCorrection(db);
  return latest?.correction.trim() ? latest.correction : null;
}

/** The sender-preferences block injected into a reply (parallel of UserContext). */
export interface PreferencesContext {
  content: string;
  /** Trace payload for the "communication preferences loaded" step. */
  data: { userId: string; version: number };
}

/**
 * Server-only: the latest communication preferences of a sender, formatted for
 * injection as a system message on a reply. Null when the user has no
 * preferences yet (nothing useful to inject).
 */
export async function getPreferencesContext(
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<PreferencesContext | null> {
  const latest = await getLatestPreference(db, userId);
  if (!latest) return null;
  const [user] = await getKnownUsersByIds(undefined, [userId]);
  const label = user ? formatKnownUserLabel(user) : `user ${userId}`;
  const content = formatPreferencesContext({
    label,
    likes: latest.likes,
    dislikes: latest.dislikes,
  });
  if (!content) return null;
  return { content, data: { userId, version: latest.version } };
}

/** A feedback row resolved with its sender's label (dashboard). */
export interface UserFeedbackView extends UserFeedback {
  userLabel: string;
}

/** A preferences snapshot resolved with its user's label (dashboard). */
export interface CommunicationPreferenceView extends CommunicationPreference {
  userLabel: string;
}

/** An exclusion resolved with the label of whoever reported it (dashboard). */
export interface AddressingExclusionView extends AddressingExclusion {
  userLabel: string;
}

/** Everything the dashboard page shows. */
export interface SelfImprovementView {
  feedbacks: UserFeedbackView[];
  preferences: CommunicationPreferenceView[];
  correction: SelfCorrection | null;
  /** Words the analyzer must not read as the bot's name (from 👎 reports). */
  exclusions: AddressingExclusionView[];
  /**
   * Why the feedback listing is missing, when it is: the rows live in the
   * source app's store, and an unreachable source must read as an outage on
   * the page, never as "no feedback yet".
   */
  feedbacksError: string | null;
}

/**
 * Aggregate dashboard view: feedbacks (from the owning source's store),
 * latest preferences per user, latest correction, and the addressing
 * exclusions those feedbacks produced.
 */
export async function getSelfImprovementView(db: StoreDb = getStoreDb()): Promise<SelfImprovementView> {
  const ports = resolveFeedbackPorts();
  let feedbacksError: string | null = null;
  const [feedbacks, preferences, correction, exclusions] = await Promise.all([
    ports
      ? ports.feedbacks.listAll().catch((err: unknown) => {
          feedbacksError = `telegram service unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`;
          return [] as UserFeedback[];
        })
      : (() => {
          feedbacksError =
            "telegram service is not configured (TG_API_URL / INTERNAL_API_TOKEN)";
          return Promise.resolve([] as UserFeedback[]);
        })(),
    listLatestPreferences(db),
    getLatestCorrection(db),
    listAddressingExclusions(db),
  ]);
  const userIds = [
    ...feedbacks.map((f) => f.userId),
    ...preferences.map((p) => p.userId),
    ...exclusions.flatMap((e) => (e.userId ? [e.userId] : [])),
  ];
  const users = await getKnownUsersByIds(undefined, userIds);
  const labels = new Map(users.map((u) => [u.userId, formatKnownUserLabel(u)]));
  const labelFor = (userId: string) => labels.get(userId) ?? `user ${userId}`;
  return {
    feedbacks: feedbacks.map((f) => ({ ...f, userLabel: labelFor(f.userId) })),
    preferences: preferences.map((p) => ({ ...p, userLabel: labelFor(p.userId) })),
    correction,
    exclusions: exclusions.map((e) => ({
      ...e,
      userLabel: e.userId ? labelFor(e.userId) : "—",
    })),
    feedbacksError,
  };
}

/**
 * Remove an addressing exclusion: the operator's undo when a word was excluded
 * in error, after which the analyzer may match it again. Traced like any other
 * mutation of learned state.
 */
export async function removeAddressingExclusion(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<AddressingExclusion | null> {
  const trace = await startTrace({
    feature: FEEDBACK_FEATURE.id,
    action: "exclusion-delete",
    trigger: { kind: "dashboard", actor: "operator" },
    inputSummary: `remove addressing exclusion ${id}`,
  });
  try {
    const removed = await deleteAddressingExclusion(db, id);
    if (!removed) {
      await trace.skip("exclusion not found");
      return null;
    }
    await trace.event({
      type: "db",
      level: "success",
      message: `addressing exclusion removed: "${removed.term}"`,
      data: { exclusion: removed },
    });
    publishEvent(FEEDBACK_FEATURE.realtimeTopic);
    await trace.succeed({ outputSummary: `"${removed.term}" is matchable again` });
    return removed;
  } catch (err) {
    await trace.fail(err);
    throw err;
  }
}
