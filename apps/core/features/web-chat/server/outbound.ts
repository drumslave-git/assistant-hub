import "server-only";

import { ApiError } from "@/lib/api-error";
import type { SourceOutboundPort } from "@/server/turn/source-outbound";

import { describeOnInsert, insertMedia } from "./media-repository";
import {
  appendMessage,
  getThreadById,
  markMessageDeleted,
  setGeneratedTitle,
} from "./repository";
import { pingThreads } from "./service";

/**
 * The web chat's outbound port — what used to be the chat app's
 * `/internal/chats/*` send API, as direct store writes since the dissolve.
 * "Delivering" to a web thread is storing the line and pinging the dashboard,
 * because the thread is already on screen — there is no platform to hand it
 * to. The port shape is tg's, so every caller (voice replies, generated
 * images, browsing acknowledgements, conversation naming) stays one client.
 */

async function requireThread(threadId: string): Promise<void> {
  const thread = await getThreadById(threadId);
  if (!thread) throw ApiError.notFound(`thread ${threadId} not found`);
}

export function webChatOutbound(): SourceOutboundPort {
  return {
    async sendMessage(threadId, opts) {
      await requireThread(threadId);
      const stored = await appendMessage({
        threadId,
        role: "assistant",
        content: opts.text,
        replyToMessageId: opts.replyToMessageId ?? null,
      });
      pingThreads();
      return { messageId: stored.id };
    },

    /**
     * A voice reply: the pipeline synthesized the audio; this stores it as an
     * assistant message with the spoken text as its content — that text is
     * what the transcript, the window and the next turn read, exactly as tg
     * mirrors the words rather than the bubble. `asVoice` is always true
     * here: a browser plays whatever it is given, so there is no refusal to
     * fall back from.
     */
    async sendVoice(threadId, opts) {
      await requireThread(threadId);
      const stored = await appendMessage({
        threadId,
        role: "assistant",
        content: opts.text,
        replyToMessageId: opts.replyToMessageId ?? null,
      });
      // The audio needs no describing — its words are the message's own text.
      await describeOnInsert({
        messageId: stored.id,
        kind: "voice",
        mimeType: "audio/ogg",
        frames: [opts.audioBase64],
        description: opts.text,
      }).catch(() => null);
      pingThreads();
      return { messageId: stored.id, asVoice: true };
    },

    /**
     * Generated images. One message per image, each carrying the picture as
     * `pending` media so the vision pass describes what the assistant itself
     * put in the thread (tg does the same).
     */
    async sendPhotos(threadId, opts) {
      await requireThread(threadId);
      const delivered: Array<{ messageId: number; stored: boolean }> = [];
      for (const image of opts.images) {
        const message = await appendMessage({ threadId, role: "assistant", content: "" });
        const media = await insertMedia({
          messageId: message.id,
          kind: "image",
          mimeType: "image/png",
          frames: [image],
        }).catch(() => null);
        delivered.push({ messageId: message.id, stored: media !== null });
      }
      pingThreads();
      return { delivered };
    },

    /**
     * A file the assistant produced (a browser-run download). The caption is
     * the message's text; the bytes are kept as media so the thread can offer
     * them back — a web thread has nowhere else to put a file. Nothing to
     * describe: the caption already says what it is, and a pending row would
     * send the backfill after a file it cannot read.
     */
    async sendFile(threadId, opts) {
      await requireThread(threadId);
      const message = await appendMessage({
        threadId,
        role: "assistant",
        content: opts.caption ?? opts.filename,
      });
      await describeOnInsert({
        messageId: message.id,
        kind: "file",
        mimeType: opts.mime ?? null,
        frames: [opts.buffer.toString("base64")],
        description: opts.filename,
      }).catch(() => null);
      pingThreads();
      return { messageId: message.id };
    },

    async deleteMessage(threadId, messageId) {
      const deleted = await markMessageDeleted(threadId, messageId);
      if (deleted) pingThreads();
      return { deleted };
    },

    /**
     * Name a thread from what was said in it — the answer to the thread's
     * `titleProvisional` flag. Ignored once the thread has a name someone
     * chose: a late-arriving generated title must not overwrite it.
     */
    async setChatTitle(threadId, title) {
      const row = await setGeneratedTitle(threadId, title);
      if (!row) {
        const current = await getThreadById(threadId);
        if (!current) throw ApiError.notFound(`thread ${threadId} not found`);
        return { title: current.name };
      }
      pingThreads();
      return { title: row.name };
    },
  };
}
