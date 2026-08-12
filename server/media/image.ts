import "server-only";

import sharp from "sharp";

/**
 * A tiny generated PNG for the vision connection probe — the image twin of
 * `tinySilenceWav`. A solid-colored square is enough to prove the endpoint
 * accepts and processes image input; 32px keeps it above any provider's
 * minimum-dimension rejection while staying a few hundred bytes on the wire.
 */
export async function tinyProbePng(size = 32): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 200, g: 40, b: 40 },
    },
  })
    .png()
    .toBuffer();
}
