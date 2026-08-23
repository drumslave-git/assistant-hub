import "server-only";

import {
  internalFeedbackResponseSchema,
  internalFeedbacksResponseSchema,
  operatorMessageResponseSchema,
  type InternalFeedback,
} from "@assistant-hub/contracts";

import { getEnv } from "@/server/env";
import type { UserFeedback } from "../types";

/**
 * The feedback rows live in the owning source's store since the split; the
 * core's learning jobs (reflection, the daily folds, the dashboard view)
 * reach them through these ports — reads plus the write-backs (model,
 * reflection, fold-version stamps). Injected everywhere they are used, so
 * the whole learning pipeline runs in tests against in-memory fakes.
 */

export interface FeedbackWriteBack {
  model?: string;
  reflection?: string;
  reflectionModel?: string;
  prefsVersion?: number;
  correctionsVersion?: number;
}

export interface FeedbackStorePort {
  /** All rows, newest first (dashboard). */
  listAll(): Promise<UserFeedback[]>;
  /** The fold backlogs: completed quality rows the fold has not stamped. */
  listUnincorporated(kind: "prefs" | "corrections"): Promise<UserFeedback[]>;
  get(id: string): Promise<UserFeedback | null>;
  patch(id: string, patch: FeedbackWriteBack): Promise<void>;
}

/**
 * One mirrored message, as the exchange renderer needs it: the text and the
 * reply pointer. The source owns the mirror; media annotations resolve to
 * their description when present.
 */
export interface SourceMessage {
  content: string;
  replyToSourceMessageId: string | null;
}

export interface SourceMessagePort {
  getMessage(chatId: string, sourceMessageId: string): Promise<SourceMessage | null>;
}

/** The two ports every learning-job entry resolves together. */
export interface FeedbackPorts {
  feedbacks: FeedbackStorePort;
  messages: SourceMessagePort;
}

function toUserFeedback(feedback: InternalFeedback): UserFeedback {
  return {
    id: feedback.id,
    chatId: feedback.chatId,
    telegramMessageId: Number(feedback.sourceMessageId),
    userId: feedback.userId,
    reaction: feedback.reaction,
    feedback: feedback.feedback,
    status: feedback.status,
    topic: feedback.topic,
    model: feedback.model ?? "",
    reflection: feedback.reflection,
    reflectionModel: feedback.reflectionModel,
    prefsVersion: feedback.prefsVersion,
    correctionsVersion: feedback.correctionsVersion,
    createdAt: feedback.createdAt,
    updatedAt: feedback.updatedAt,
  };
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The tg-API-backed ports, or null when the source API is not configured —
 * callers then skip exactly like an unconfigured LLM: the job reports why,
 * nothing pretends to have run.
 */
export function resolveFeedbackPorts(): FeedbackPorts | null {
  const env = getEnv();
  if (!env.TG_API_URL || !env.INTERNAL_API_TOKEN) return null;
  const baseUrl = env.TG_API_URL.replace(/\/$/, "");
  const token = env.INTERNAL_API_TOKEN;

  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-internal-token": token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? `tg internal API ${path} answered ${res.status}`);
    }
    return res.json();
  };

  return {
    feedbacks: {
      async listAll() {
        const body = internalFeedbacksResponseSchema.parse(await request("/internal/feedbacks"));
        return body.feedbacks.map(toUserFeedback);
      },
      async listUnincorporated(kind) {
        const body = internalFeedbacksResponseSchema.parse(
          await request(`/internal/feedbacks?needs=${kind}`),
        );
        return body.feedbacks.map(toUserFeedback);
      },
      async get(id) {
        const body = internalFeedbackResponseSchema.parse(
          await request(`/internal/feedbacks/${encodeURIComponent(id)}`),
        );
        return body.feedback ? toUserFeedback(body.feedback) : null;
      },
      async patch(id, patch) {
        await request(`/internal/feedbacks/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
      },
    },
    messages: {
      async getMessage(chatId, sourceMessageId) {
        const body = operatorMessageResponseSchema.parse(
          await request(
            `/internal/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(sourceMessageId)}`,
          ),
        );
        if (!body.message) return null;
        // A media message's readable content is its description when the
        // text is empty (a photo answered "what is this?").
        const content =
          body.message.content ||
          (body.message.media?.description ? `[${body.message.media.description}]` : "");
        return { content, replyToSourceMessageId: body.message.replyToSourceMessageId };
      },
    },
  };
}
