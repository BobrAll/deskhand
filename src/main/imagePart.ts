/**
 * Turns a `data:` URL into an image part for the model.
 *
 * The screenshot comes back from `screencapture`-based capture as a data URL,
 * and a request that carries it needs it as `{ type: 'image', mimeType, base64 }`
 * rather than the raw string. The extraction lives here, out of the request
 * builder, because it is the only part of building a message that is pure string
 * work: the caller decides *whether* there is an image, this decides whether the
 * URL can become one.
 *
 * Returns `null` for anything that is not a base64 image data URL, which is the
 * same "no image" answer the caller already handles.
 */

import type { ContentPart } from './llm/provider'

const DATA_URL = /^data:(image\/[\w+.-]+);base64,(.*)$/i

export function imagePart(dataUrl: string | null | undefined): ContentPart | null {
  if (!dataUrl) return null
  const match = DATA_URL.exec(dataUrl)
  if (!match) return null
  return { type: 'image', mimeType: match[1], base64: match[2] }
}
