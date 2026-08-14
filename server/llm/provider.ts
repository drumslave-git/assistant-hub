import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel, ImageModel, LanguageModel } from "ai";

import { ApiError } from "@/lib/api-error";
import { toLlmBackendId } from "@/lib/llm-backend";

import { toOpenAiBaseUrl, type LlmConnection } from "./client";

/**
 * One way to build the provider, shared by every modality that speaks to an
 * LLM endpoint — chat (`./transport`), embeddings, and images.
 *
 * It exists so the three cannot drift on the two things that are easy to get
 * subtly wrong: the base URL normalization, and the name `providerOptions` is
 * keyed under. Chat briefly had its own copy that skipped the URL normalization,
 * which worked only because the stored setting happened to already end in `/v1`.
 *
 * Almost every backend speaks the OpenAI wire shape and rides
 * `createOpenAICompatible`. Anthropic is the exception: its native Messages API
 * is a different protocol (`x-api-key` auth, `anthropic-version` header, a
 * different body), so a backend declared `anthropic` gets the AI SDK's native
 * provider instead. Everything downstream — the transport, the tool loop, the
 * trace bodies — is unchanged; the provider is where the wire dialect lives.
 */

/**
 * The name the SDK keys `providerOptions` under **for OpenAI-compatible
 * backends**.
 *
 * Constant rather than the backend id: the adapter already decides *what* to
 * send, so keying by backend would only add a way for the two to disagree. The
 * Anthropic provider is the exception — its options key is fixed by the SDK to
 * `anthropic` — which is why callers resolve the key through
 * {@link providerOptionsName} rather than using this constant directly.
 */
export const PROVIDER_NAME = "llm";

/** The name a chat call's `providerOptions` must be keyed under for `conn`. */
export function providerOptionsName(conn: LlmConnection): string {
  return toLlmBackendId(conn.backend) === "anthropic" ? "anthropic" : PROVIDER_NAME;
}

/** The model factories a connection's provider must offer, whatever the wire. */
export interface LlmProvider {
  languageModel(modelId: string): LanguageModel;
  embeddingModel(modelId: string): EmbeddingModel;
  imageModel(modelId: string): ImageModel;
}

/** The provider for one connection. Cheap — a config object, not a socket. */
export function createProvider(conn: LlmConnection): LlmProvider {
  if (toLlmBackendId(conn.backend) === "anthropic") {
    const anthropic = createAnthropic({
      // Anthropic's real base is `https://api.anthropic.com/v1` — the same
      // `/v1` normalization every stored base URL already gets.
      baseURL: toOpenAiBaseUrl(conn.baseUrl),
      // Always explicit, never the SDK's ANTHROPIC_API_KEY env fallback:
      // configuration lives in the DB-backed catalog. An empty key reaches the
      // endpoint and comes back as its own honest 401.
      apiKey: conn.apiKey?.trim() || "",
    });
    return {
      languageModel: (modelId) => anthropic.languageModel(modelId),
      // The native provider would throw the SDK's NoSuchModelError here; these
      // name the actual configuration mistake instead — the operator pointed a
      // role at a backend that cannot serve it.
      embeddingModel: () => {
        throw ApiError.badRequest(
          "Anthropic backends serve chat models only — pick a different backend for embeddings",
        );
      },
      imageModel: () => {
        throw ApiError.badRequest(
          "Anthropic backends serve chat models only — pick a different backend for image generation",
        );
      },
    };
  }
  return createOpenAICompatible({
    name: PROVIDER_NAME,
    // Normalized, not taken as typed: an operator who enters
    // `http://host:11434` means the same endpoint as `http://host:11434/v1`,
    // and every other path in this app has always accepted both.
    baseURL: toOpenAiBaseUrl(conn.baseUrl),
    ...(conn.apiKey?.trim() ? { apiKey: conn.apiKey.trim() } : {}),
  });
}
