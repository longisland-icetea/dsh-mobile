import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Cap the admin-approved extra WebSocket upgrade paths (exact pathnames). */
export const MAX_EXTRA_WEBSOCKET_PATHS = 16
export const MAX_WEBSOCKET_PATH_LENGTH = 256

function fail(code: string): never {
  throw new Error(code)
}

/**
 * Validate one exact pathname for proxying. Query strings are matched at
 * upgrade time, so only the pathname is stored. Rejects anything the
 * gateway cannot match exactly.
 */
export function validateWebSocketPath(value: unknown): string {
  if (typeof value !== 'string') fail('websocket_path_invalid')
  const path = value as string
  if (path.length === 0 || path.length > MAX_WEBSOCKET_PATH_LENGTH) fail('websocket_path_invalid')
  if (!path.startsWith('/')) fail('websocket_path_invalid')
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f#?]/u.test(path)) fail('websocket_path_invalid')
  if (path.includes('..')) fail('websocket_path_invalid')
  return path
}

/** Validate a whole replacement list all-or-nothing; duplicates collapse. */
export function normalizeWebSocketPaths(value: unknown): string[] {
  if (!Array.isArray(value)) fail('websocket_paths_invalid')
  if (value.length > MAX_EXTRA_WEBSOCKET_PATHS) fail('websocket_paths_invalid')
  const seen = new Set<string>()
  for (const entry of value) {
    const path = validateWebSocketPath(entry)
    seen.add(path)
  }
  return [...seen]
}

/** File-backed store shared by every gateway instance (LAN and remote). */
export class WebSocketPathStore {
  private paths = new Set<string>()
  private loaded = false

  constructor(private readonly file: string) {}

  /** Snapshot for the upgrade check. */
  has(pathname: string): boolean {
    return this.paths.has(pathname)
  }

  list(): string[] {
    return [...this.paths]
  }

  async load(): Promise<string[]> {
    if (!this.loaded) {
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as { readonly paths?: unknown }
        this.paths = new Set(normalizeWebSocketPaths(raw.paths ?? []))
      } catch {
        // Missing, corrupt, or unreadable: fall back to the empty (most
        // restrictive) list. The panel always shows the active list, so an
        // admin notices and re-adds entries instead of silently widening.
        this.paths = new Set()
      }
      this.loaded = true
    }
    return this.list()
  }

  /** Replace the whole list after validating; persists atomically. */
  async replace(paths: readonly string[]): Promise<string[]> {
    const next = normalizeWebSocketPaths([...paths])
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, `${JSON.stringify({ paths: next })}\n`, 'utf8')
    this.paths = new Set(next)
    this.loaded = true
    return this.list()
  }
}
