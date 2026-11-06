/**
 * File types that run code when opened. Hush never opens files itself; these get a warning
 * in the chat and before saving.
 */
const RISKY = new Set([
  // Windows
  'exe', 'msi', 'msix', 'msp', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'lnk', 'reg', 'dll', 'jar', 'appx', 'appxbundle', 'application', 'gadget', 'inf', 'scf', 'url',
  // Linux / cross-platform
  'sh', 'bash', 'zsh', 'run', 'bin', 'appimage', 'desktop', 'deb', 'rpm', 'py', 'pl', 'rb', 'elf', 'out', 'command', 'app', 'pkg', 'dmg'
])

export function fileExtension(name: string): string {
  const clean = name.replace(/[. ]+$/, '') // Windows drops these when saving: "setup.exe." is setup.exe
  const i = clean.lastIndexOf('.')
  return i > 0 ? clean.slice(i + 1).toLowerCase() : ''
}

export function isRiskyFile(name: string): boolean {
  return RISKY.has(fileExtension(name))
}

/** "1.2 MB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  webm: 'video/webm', mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', tar: 'application/x-tar', gz: 'application/gzip'
}

/** A type for display and for the receiver's Save dialog — never trusted for anything else. */
export function guessMime(name: string): string {
  return MIME[fileExtension(name)] ?? 'application/octet-stream'
}

/** A safe display name from whatever the OS or clipboard gave us (keeps the extension). */
export function cleanFileName(raw: string): string {
  let name = raw.replace(/[/\\]/g, '_').replace(/\p{Cc}/gu, '').trim()
  if (name === '' || name === '.' || name === '..') name = 'file'
  if (name.length > 255) {
    const ext = fileExtension(name).slice(0, 32)
    name = name.slice(0, 255 - (ext ? ext.length + 1 : 0)).trimEnd() + (ext ? `.${ext}` : '')
  }
  return name
}
