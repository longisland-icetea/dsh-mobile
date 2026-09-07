import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_EXTRA_WEBSOCKET_PATHS,
  normalizeWebSocketPaths,
  validateWebSocketPath,
  WebSocketPathStore,
} from '../src/websocket-paths.js'

describe('third-party WebSocket upgrade paths', () => {
  it('accepts exact plugin pathnames', () => {
    expect(validateWebSocketPath('/sidebar/ws/terminal')).toBe('/sidebar/ws/terminal')
    expect(validateWebSocketPath('/a')).toBe('/a')
  })

  it.each([
    ['missing leading slash', 'sidebar/ws/terminal'],
    ['empty path', ''],
    ['query string rides along and is not stored', '/sidebar/ws/terminal?sessionId=x'],
    ['fragment', '/sidebar/ws/terminal#frag'],
    ['whitespace', '/sidebar/ws/ terminal'],
    ['control characters', '/sidebar/ws/\u0001terminal'],
    ['dot-dot segments', '/sidebar/../terminal'],
    ['non-strings', 42],
  ])('rejects %s', (_name, value) => {
    expect(() => validateWebSocketPath(value)).toThrow('websocket_path_invalid')
  })

  it('dedupes and caps the replacement list all-or-nothing', () => {
    expect(normalizeWebSocketPaths(['/a', '/a', '/b'])).toEqual(['/a', '/b'])
    expect(normalizeWebSocketPaths([])).toEqual([])
    const tooMany = Array.from({ length: MAX_EXTRA_WEBSOCKET_PATHS + 1 }, (_, index) => `/p${String(index)}`)
    expect(() => normalizeWebSocketPaths(tooMany)).toThrow('websocket_paths_invalid')
    expect(() => normalizeWebSocketPaths('nope')).toThrow('websocket_paths_invalid')
    expect(() => normalizeWebSocketPaths(['/ok', '/bad path'])).toThrow('websocket_path_invalid')
  })

  it('persists replacements and falls back to empty on a missing or corrupt file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'dsh-ws-paths-')), 'websocket-paths.json')
    const store = new WebSocketPathStore(file)
    expect(await store.load()).toEqual([])
    expect(await store.replace(['/sidebar/ws/terminal'])).toEqual(['/sidebar/ws/terminal'])
    expect(store.has('/sidebar/ws/terminal')).toBe(true)
    expect(store.has('/other')).toBe(false)
    const reloaded = new WebSocketPathStore(file)
    expect(await reloaded.load()).toEqual(['/sidebar/ws/terminal'])
    await writeFile(file, 'not json{{{', 'utf8')
    expect(await new WebSocketPathStore(file).load()).toEqual([])
  })
})
