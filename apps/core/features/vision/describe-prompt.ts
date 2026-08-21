/**
 * The context-free vision describe prompt. A separate model pass reads an image
 * and writes a thorough plain-text description that later stands in for the image
 * in history (so past turns stay token-light). Ported from the MVP — the
 * description must be exhaustive because anything omitted is lost once the bytes
 * are dropped.
 */

/** Enough tokens for dense transcription + scene/object detail. */
export const VISION_DESCRIBE_MAX_TOKENS = 2048;

export const VISION_DESCRIBE_SYSTEM = `You describe images for a Telegram chat bot's memory. Another model reads your text later — anything you omit is lost forever.

Write a thorough plain-text description. No markdown, no preamble ("In this image…"), no bullet syntax.

Extract all visible information that could matter in conversation:
- Image kind (photo, screenshot, meme, sticker artwork, diagram, document scan, etc.)
- People: count, appearance, clothing, pose, expression, actions; approximate age only if obvious
- Objects, products, brands, logos, icons, UI elements, windows, apps, games
- Text: transcribe ALL readable text verbatim (captions, signs, memes, subtitles, watermarks, buttons, errors)
- Numbers: record EVERY visible number exactly as shown — prices, dates, times, scores, stats, counts, percentages, phone/ID/account numbers, measurements, dimensions, version codes, addresses, timers, chart values, table figures
- Setting: place, indoor/outdoor, time of day, weather, background details
- Colors, lighting, art style, composition, mood or emotion the image conveys
- For stickers: characters, scene, symbols, style, implied meaning (use the attached artwork, not emoji alone)

Be exhaustive and factual — describe only what is visible. Note uncertainty when details are ambiguous.
Use multiple short paragraphs or plain labeled lines. Never collapse into one or two sentences.`;

export const VISION_DESCRIBE_USER = "Describe the attached image in full detail for chat context.";
