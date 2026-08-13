import "server-only";

import { ApiError } from "@/lib/api-error";

import { generateImage } from "ai";

import { toLlmError, type LlmConnection } from "./client";
import { createProvider } from "./provider";

/**
 * Shared client for OpenAI-compatible `/v1/images/generations` endpoints — the
 * third sibling of {@link import("./client")} (chat) and
 * {@link import("./embeddings")} (vectors).
 *
 * Image generation almost never comes from the chat model, and often not even
 * from the same host (a diffusion model rarely lives beside the LLM), so the
 * connection is passed in explicitly; the settings service resolves it from the
 * DB, falling back to the LLM connection when no image base URL is configured.
 *
 * Requests go through the same AI SDK provider as chat (`./provider`), so the
 * base URL, key and `providerOptions` keying are resolved identically. The
 * provider asks for base64 itself and normalizes a backend that answers with a
 * URL instead, which is why no `response_format` is specified here.
 */

/**
 * Generation is far slower than chat — a diffusion model can spend minutes on one
 * image, and the caller is a background-ish tool call, not a page render.
 */
const IMAGE_TIMEOUT_MS = 300_000;

/**
 * Bound on the Settings probe. Generous, because it now renders a real image
 * and a diffusion model legitimately takes tens of seconds — but far short of
 * the tool path's deadline, since an operator is watching this one.
 */
const PROBE_TIMEOUT_MS = 120_000;

/** The probe renders at this size: the smallest square every endpoint accepts. */
const PROBE_IMAGE_SIZE: ImageSize = [512, 512];

/** What the probe asks for — short, unambiguous, and cheap to render. */
const PROBE_PROMPT = "A single red circle centered on a white background.";

/** Image dimensions as [width, height] in pixels. */
export type ImageSize = [number, number];

/** Default size when the model does not ask for one. */
export const DEFAULT_IMAGE_SIZE: ImageSize = [1024, 1024];

/** A resolved image connection: where to call, and which model to ask for. */
export interface ImageRuntime extends LlmConnection {
  model: string;
}

export interface GenerateImagesInput {
  prompt: string;
  size?: ImageSize;
  /** Wire deadline; defaults to the generous tool-path bound. */
  timeoutMs?: number;
}

/**
 * Generate one or more images from a prompt, returning the base64 payloads in the
 * order the endpoint produced them. Throws a clean {@link ApiError} on provider
 * failure, or when the endpoint answers without any image data (a success status
 * with an empty payload is a failure from the caller's point of view — there is
 * nothing to send to the chat).
 */
export async function generateImages(
  runtime: ImageRuntime,
  input: GenerateImagesInput,
): Promise<string[]> {
  const size = input.size ?? DEFAULT_IMAGE_SIZE;
  try {
    const result = await generateImage({
      model: createProvider(runtime).imageModel(runtime.model),
      prompt: input.prompt,
      size: `${size[0]}x${size[1]}`,
      // A diffusion model can spend minutes on one image, and the caller is a
      // tool call rather than a page render — so the deadline is generous, and
      // the retry is the caller's to decide, not a silent second render.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(input.timeoutMs ?? IMAGE_TIMEOUT_MS),
    });
    // `base64` is what the callers store and send; the SDK exposes the same
    // bytes as `uint8Array`, so no `response_format` needs requesting — it
    // asks for base64 itself and normalizes providers that answer with a URL.
    const images = result.images.map((image) => image.base64).filter(Boolean);
    if (images.length === 0) {
      throw ApiError.serviceUnavailable("Image endpoint returned no image data");
    }
    return images;
  } catch (err) {
    throw toLlmError(err, runtime.baseUrl);
  }
}

/** What the image probe asked for and what came back. */
export interface ImageProbe {
  model: string;
  /** The prompt the probe sent, so the operator can judge the result against it. */
  prompt: string;
  /** The generated image, base64-encoded. */
  imageBase64: string;
}

/**
 * Real probe of the image configuration: actually generates a small image from
 * a fixed prompt and hands back the bytes.
 *
 * It used to only list models, on the reasoning that nothing about a generated
 * image can *only* be learned by generating one. That was wrong in the way that
 * matters: a listed model still fails on the size it is asked for, returns a URL
 * the provider then 404s, or answers with an empty payload — all of which the
 * listing happily calls fine and the chat only discovers when a user asks for a
 * picture. The operator asked to see the picture; seeing it is the proof.
 */
export async function probeImages(runtime: ImageRuntime): Promise<ImageProbe> {
  const [imageBase64] = await generateImages(runtime, {
    prompt: PROBE_PROMPT,
    size: PROBE_IMAGE_SIZE,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return { model: runtime.model, prompt: PROBE_PROMPT, imageBase64 };
}
