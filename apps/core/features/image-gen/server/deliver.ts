import "server-only";

import { recordAssistantMessage } from "@/features/history/server/service";
import { ingestGeneratedImage } from "@/features/vision/server/service";
import type { ReplyTransport } from "@/server/telegram/transport";

/**
 * Delivery of the images `image_generate` produced during a turn: send each one to
 * the chat, then store it as ordinary media so the vision describer recognizes it
 * exactly like a user-sent picture (user decision, 2026-07-17).
 *
 * Each delivered photo becomes the same pair of rows an incoming media message
 * produces — a media-only `chat_messages` assistant row (the picture *is* the
 * message) and a pending `message_media` row keyed by it. Recognition then happens
 * on the normal vision path, which is what lets a later turn know what the bot
 * drew instead of finding a hole in the transcript.
 *
 * Runs after the text reply, so the acknowledgement arrives before the picture it
 * acknowledges.
 */

/** One delivered image: what was sent, and the rows it produced. */
export interface DeliveredImage {
  messageId: number;
  /** False when the image was sent but its media row could not be stored. */
  stored: boolean;
}

export interface DeliverImagesParams {
  transport: Pick<ReplyTransport, "sendPhoto">;
  chatId: string;
  images: string[];
  threadId?: number;
}

/**
 * Deliver and store each image. Best-effort per image and never throws: the reply
 * is already out, and a mirroring failure must not turn a picture the user can see
 * into a failed turn. A send failure skips that image's rows entirely — there is no
 * message id to key them to.
 */
export async function deliverGeneratedImages(
  params: DeliverImagesParams,
): Promise<DeliveredImage[]> {
  const delivered: DeliveredImage[] = [];
  for (const [index, base64] of params.images.entries()) {
    try {
      const sent = await params.transport.sendPhoto(
        { base64, filename: `image-${index + 1}.png` },
        { ...(params.threadId != null ? { threadId: params.threadId } : {}) },
      );
      await recordAssistantMessage({
        chatId: params.chatId,
        telegramMessageId: sent.messageId,
        content: "",
        hasMedia: true,
      });
      // Keyed by the file id Telegram minted on send: the row describes the photo
      // as it now exists in the chat, not the bytes we happened to upload.
      const media = sent.fileId
        ? await ingestGeneratedImage({
            chatId: params.chatId,
            telegramMessageId: sent.messageId,
            fileId: sent.fileId,
            fileUniqueId: sent.fileUniqueId,
            base64,
          })
        : null;
      delivered.push({ messageId: sent.messageId, stored: media != null });
    } catch (err) {
      console.error(
        "Failed to deliver a generated image:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return delivered;
}
