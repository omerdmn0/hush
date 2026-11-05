import { IMAGE_MIME, MAX_IMAGE_BYTES } from '../../../shared/protocol'
import type { OutgoingImage } from '../../../shared/types'

const PREVIEW_MAX_SIDE = 480
const PREVIEW_MAX_BYTES = 140 * 1024

export type ImageProblem = 'unsupported' | 'too-large' | 'unreadable'

export class ImageError extends Error {
  constructor(
    readonly problem: ImageProblem,
    readonly fileName: string
  ) {
    super(problem)
  }
}

export function imageErrorText(e: ImageError): string {
  const name = e.fileName ? `“${e.fileName}”` : 'That file'
  switch (e.problem) {
    case 'unsupported':
      return `${name} isn't a supported image. Use PNG, JPEG, GIF or WebP.`
    case 'too-large':
      return `${name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`
    case 'unreadable':
      return `${name} couldn't be opened as an image.`
  }
}

export interface PreparedImage {
  key: string
  name: string
  /** Object URL for the tray preview; revoke when done. */
  previewUrl: string
  outgoing: OutgoingImage
}

/** Validates a picked/dropped/pasted file and makes the small WebP preview that travels inline. */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!(IMAGE_MIME as readonly string[]).includes(file.type)) throw new ImageError('unsupported', file.name)
  if (file.size > MAX_IMAGE_BYTES) throw new ImageError('too-large', file.name)

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file) // respects EXIF orientation
  } catch {
    throw new ImageError('unreadable', file.name)
  }
  const { width, height } = bitmap
  let thumb: Blob | null = null
  for (const [side, quality] of [
    [PREVIEW_MAX_SIDE, 0.78],
    [PREVIEW_MAX_SIDE, 0.6],
    [320, 0.6]
  ] as const) {
    const scale = Math.min(1, side / Math.max(width, height))
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    thumb = await canvas.convertToBlob({ type: 'image/webp', quality })
    if (thumb.size <= PREVIEW_MAX_BYTES) break
  }
  bitmap.close()

  return {
    key: crypto.randomUUID(),
    name: file.name || 'pasted image',
    previewUrl: URL.createObjectURL(file),
    outgoing: {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
      width,
      height,
      thumb: new Uint8Array(await thumb!.arrayBuffer())
    }
  }
}

/** Display size for a thumbnail inside a bubble, keeping the aspect ratio. */
export function thumbSize(width: number, height: number, maxW = 300, maxH = 320): { width: number; height: number } {
  const scale = Math.min(1, maxW / width, maxH / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}
