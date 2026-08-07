import "server-only";

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { toOpenAiBaseUrl, type LlmConnection } from "./client";

/**
 * One way to build the provider, shared by every modality that speaks to an
 * OpenAI-compatible endpoint — chat (`./transport`), embeddings, and images.
 *
 * It exists so the three cannot drift on the two things that are easy to get
 * subtly wrong: the base URL normalization, and the name `providerOptions` is
 * keyed under. Chat briefly had its own copy that skipped the URL normalization,
 * which worked only because the stored setting happened to already end in `/v1`.
 */

/**
 * The name the SDK keys `providerOptions` under.
 *
 * Constant rather than the backend id: the adapter already decides *what* to
 * send, so keying by backend would only add a way for the two to disagree.
 */
export const PROVIDER_NAME = "llm";

/** The provider for one connection. Cheap — a config object, not a socket. */
export function createProvider(conn: LlmConnection) {
  return createOpenAICompatible({
    name: PROVIDER_NAME,
    // Normalized, not taken as typed: an operator who enters
    // `http://host:11434` means the same endpoint as `http://host:11434/v1`,
    // and every other path in this app has always accepted both.
    baseURL: toOpenAiBaseUrl(conn.baseUrl),
    ...(conn.apiKey?.trim() ? { apiKey: conn.apiKey.trim() } : {}),
  });
}
