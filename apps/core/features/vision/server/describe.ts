import "server-only";

import type { ChatMessage } from "@/server/llm/client";

import { buildVisionContent } from "../format";
import type { ImagePayload } from "../types";
import { VISION_DESCRIBE_SYSTEM, VISION_DESCRIBE_USER } from "../describe-prompt";

/**
 * Assemble the messages for a context-free describe pass: the describe system
 * prompt plus a single vision `user` turn carrying the images and any hint
 * (e.g. a sticker's emoji). Pure — the service runs it through the LLM client
 * and records the trace.
 */
export function buildDescribeMessages(images: ImagePayload[], hint: string | null): ChatMessage[] {
  const prompt = [VISION_DESCRIBE_USER, hint].filter(Boolean).join("\n\n");
  return [
    { role: "system", content: VISION_DESCRIBE_SYSTEM },
    { role: "user", content: buildVisionContent(prompt, images) },
  ];
}
