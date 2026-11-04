/**
 * Turns a `data:` URL into an image part for the model.
 *
 * The screenshot comes back from `screencapture`-based capture as a data URL, and
 * the three requests of one turn — the question, a `@look` continuation, and the
 * verification check — each have to carry it as `{ type: 'image', mimeType,
 * base64 }`. That extraction was written out three times in `overlay.ts` with the
 * same regex and the same `parts.push`; it lives here once now.
 *
 * Returns `null` for anything that is not a base64 image data URL, which is the
 * same "no image" answer the callers already handled by skipping the push.
 */

import type { ContentPart } from './llm/provider'

const DATA_URL = /^data:(image\/[\w+.-]+);base64,(.*)$/i

export function imagePart(dataUrl: string | null | undefined): ContentPart | null {
  if (!dataUrl) return null
  const match = DATA_URL.exec(dataUrl)
  if (!match) return null
  return { type: 'image', mimeType: match[1], base64: match[2] }
}
