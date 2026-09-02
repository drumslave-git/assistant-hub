import "server-only";

import type { SourceId } from "@assistant-hub-swarm/contracts";

import {
  getSourceFeedback,
  listSourceFeedbacks,
  listUnincorporatedSourceFeedbacks,
  patchSourceFeedback,
  type SourceFeedbackRecord,
} from "@/server/source-store/feedbacks";
import { getSourceMessage } from "@/server/source-store/repository";
import { getSourceMediaByMessage } from "@/server/source-store/media";
import type { UserFeedback } from "../types";

/**
 * The feedback rows live in the core's conversation store since the Phase 7
 * de-storing; the learning jobs (reflection, the daily folds, the dashboard
 * view) reach them through these ports — reads plus the write-backs (model,
 * reflection, fold-version stamps). Still injected everywhere they are used,
 * so the whole learning pipeline runs in tests against in-memory fakes.
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
  getMessage(source: SourceId, chatId: string, sourceMessageId: string): Promise<SourceMessage | null>;
}

/** The two ports every learning-job entry resolves together. */
export interface FeedbackPorts {
  feedbacks: FeedbackStorePort;
  messages: SourceMessagePort;
}

function toUserFeedback(feedback: SourceFeedbackRecord): UserFeedback {
  return {
    id: feedback.id,
    source: feedback.source,
    chatId: feedback.chatId,
    sourceMessageId: feedback.sourceMessageId,
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
    createdAt: feedback.createdAt.toISOString(),
    updatedAt: feedback.updatedAt.toISOString(),
  };
}

/**
 * The conversation-store-backed ports. Feedback rows carry their transport,
 * and the message lookups read that transport's mirror unscoped (the
 * operator plane's read, exactly what the exchange renderer needs).
 */
export function resolveFeedbackPorts(): FeedbackPorts | null {
  return {
    feedbacks: {
      async listAll() {
        return (await listSourceFeedbacks()).map(toUserFeedback);
      },
      async listUnincorporated(kind) {
        return (await listUnincorporatedSourceFeedbacks(kind)).map(toUserFeedback);
      },
      async get(id) {
        const record = await getSourceFeedback(id);
        return record ? toUserFeedback(record) : null;
      },
      async patch(id, patch) {
        await patchSourceFeedback(id, patch);
      },
    },
    messages: {
      async getMessage(source, chatId, sourceMessageId) {
        const row = await getSourceMessage(
          { source, chatId, assistantId: null, direct: false },
          sourceMessageId,
        );
        if (!row) return null;
        // A media message's readable content is its description when the
        // text is empty (a photo answered "what is this?").
        let content = row.content;
        if (!content) {
          const media = await getSourceMediaByMessage(source, chatId, sourceMessageId).catch(
            () => null,
          );
          if (media?.description) content = `[${media.description}]`;
        }
        return { content, replyToSourceMessageId: row.replyToSourceMessageId };
      },
    },
  };
}
