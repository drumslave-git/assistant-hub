import "server-only";

import { getImageRuntime } from "@/features/settings/server/service";
import { generateImages, DEFAULT_IMAGE_SIZE, type ImageSize } from "@/server/llm/images";

import { formatImageFailure, formatImageSuccess } from "../format";

/**
 * Image-generation service core. Resolves the DB-configured image connection,
 * calls the provider, and shapes the outcome into (a) the text the model reads
 * back and (b) the base64 images the pipeline delivers to the chat.
 *
 * Never throws: a provider failure, a missing configuration, or an empty prompt
 * all resolve to an `ok: false` outcome carrying a model-readable explanation.
 * A thrown error here would abort the whole reply over a picture the user asked
 * for in passing — the model can say "I couldn't draw that" and carry on.
 */

/** Produces base64 images for a prompt. Injected in tests; real = the provider. */
export type ImageGenerator = (prompt: string, size: ImageSize) => Promise<string[]>;

export interface ImageGenDeps {
  /** Defaults to the DB-configured provider connection. */
  generate?: ImageGenerator;
}

export interface ImageGenInput {
  prompt: string;
  size?: ImageSize;
}

export interface ImageGenOutput {
  ok: boolean;
  /** Base64 images, delivered to the chat by the pipeline (never shown to the model). */
  images: string[];
  size: ImageSize;
  /** Text handed back to the model (success or failure). */
  context: string;
  /** Short outcome reason, for the trace summary. */
  reason: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The default generator: the image connection resolved from DB settings at call
 * time (so a settings change takes effect without a restart). Throws a clear,
 * model-readable error when image generation is not configured.
 */
async function generateWithConfiguredProvider(prompt: string, size: ImageSize): Promise<string[]> {
  const runtime = await getImageRuntime();
  if (!runtime) {
    throw new Error(
      "image generation is not configured (no image model set in the dashboard Settings)",
    );
  }
  return generateImages(runtime, { prompt, size });
}

/** Generate images for a prompt, shaping success and failure alike into an outcome. */
export async function runImageGeneration(
  input: ImageGenInput,
  deps: ImageGenDeps = {},
): Promise<ImageGenOutput> {
  const prompt = input.prompt.trim();
  const size = input.size ?? DEFAULT_IMAGE_SIZE;
  if (!prompt) {
    return {
      ok: false,
      images: [],
      size,
      context: formatImageFailure("", "the prompt was empty"),
      reason: "empty prompt",
    };
  }

  const generate = deps.generate ?? generateWithConfiguredProvider;
  try {
    const images = await generate(prompt, size);
    return {
      ok: true,
      images,
      size,
      context: formatImageSuccess(images.length, size),
      reason: `generated ${images.length}`,
    };
  } catch (err) {
    const reason = errorMessage(err);
    return {
      ok: false,
      images: [],
      size,
      context: formatImageFailure(prompt, reason),
      reason,
    };
  }
}
