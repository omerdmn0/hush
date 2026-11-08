import { IMAGE_MIME, MAX_AVATAR_BYTES, MAX_IMAGE_BYTES } from '../../../shared/protocol'
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
  file: File
  outgoing: Omit<OutgoingImage, 'bytes'>
}

/** The image as sent. Its bytes are only read now, so waiting in the tray costs no memory. */
export async function toOutgoing(image: PreparedImage): Promise<OutgoingImage> {
  return { ...image.outgoing, bytes: new Uint8Array(await image.file.arrayBuffer()) }
}

let preparing: Promise<unknown> = Promise.resolve()

/** One at a time: decoding a large photo takes about 100 MB while it runs. */
export function prepareImage(file: File): Promise<PreparedImage> {
  const prepared = preparing.then(() => prepare(file))
  preparing = prepared.catch(() => {})
  return prepared
}

/** Validates a picked/dropped/pasted file and makes the small WebP preview that travels inline. */
async function prepare(file: File): Promise<PreparedImage> {
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
    previewUrl: URL.createObjectURL(thumb!),
    file,
    outgoing: {
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

const AVATAR_SIDE = 256

/** Centre-crops a picked image to a square and encodes a 256 px WebP small enough to send. */
export async function makeAvatar(file: File): Promise<Uint8Array> {
  if (!(IMAGE_MIME as readonly string[]).includes(file.type)) throw new ImageError('unsupported', file.name)
  if (file.size > MAX_IMAGE_BYTES) throw new ImageError('too-large', file.name)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageError('unreadable', file.name)
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = new OffscreenCanvas(AVATAR_SIDE, AVATAR_SIDE)
  canvas
    .getContext('2d')!
    .drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIDE, AVATAR_SIDE)
  bitmap.close()
  for (const quality of [0.86, 0.7, 0.5]) {
    const blob = await canvas.convertToBlob({ type: 'image/webp', quality })
    if (blob.size <= MAX_AVATAR_BYTES) return new Uint8Array(await blob.arrayBuffer())
  }
  throw new ImageError('too-large', file.name)
}
