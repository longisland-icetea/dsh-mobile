import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readCursor, TaskNotifier, writeCursor } from '../src/task-notifier.js'

const MESSAGES = {
  notifyDone: 'Task completed',
  notifyFailed: 'Task failed',
  notifyFailedDetail: 'Task failed: {message}',
  notifyApproval: 'Input needed',
  notifyUntitledSession: 'Untitled session',
}

interface FeedEvent {
  readonly id: string
  readonly sessionId: string
  readonly kind: string
  readonly time: number
  readonly message?: unknown
}

/** Deterministic clock: each recorded event gets a later timestamp. */
let clock = 1_000
function event(kind: string, message?: unknown, sessionId = 's1'): FeedEvent {
  clock += 1
  return { id: `${clock}:${sessionId}:${kind}`, sessionId, kind, time: clock, ...(message === undefined ? {} : { message }) }
}

describe('TaskNotifier', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let shown: { title: string; body: string }[]
  let pageHidden = false
  const storage = new Map<string, string>()
  const pointerListeners = new Set<() => void>()

  beforeEach(() => {
    pageHidden = false
    storage.clear()
    pointerListeners.clear()
    fetchMock = vi.fn(async () => new Response('{"events":[]}', { status: 200 }))
    shown = []
    class NotificationCtor {
      static permission = 'granted'
      onclick: (() => void) | null = null
      constructor(title: string, options: { body?: string }) {
        shown.push({ title, body: options.body ?? '' })
      }
      close(): void {}
    }
    vi.stubGlobal('window', {
      fetch: fetchMock,
      Notification: NotificationCtor,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, String(value)) },
      },
      addEventListener: (type: string, fn: () => void) => { if (type === 'pointerdown') pointerListeners.add(fn) },
      removeEventListener: (type: string, fn: () => void) => { if (type === 'pointerdown') pointerListeners.delete(fn) },
      setInterval,
      clearInterval,
    })
    vi.stubGlobal('Notification', NotificationCtor)
    vi.stubGlobal('document', { get hidden() { return pageHidden } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts polling and pops a notification for pending events while hidden', async () => {
    const done = event('done')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [done] }), { status: 200 }))
    pageHidden = true
    const notifier = new TaskNotifier(MESSAGES)
    notifier.setTitleResolver(() => 'My session')
    const dispose = notifier.start()
    await vi.waitFor(() => expect(shown.length).toBe(1), { timeout: 2000 })
    expect(shown[0]).toEqual({ title: 'My session', body: 'Task completed' })
    expect(fetchMock).toHaveBeenCalledWith('/mobile-access/notify/pending?since=0')
    dispose()
  })

  it('maps failure details and approval bodies with the untitled fallback', async () => {
    const failed = event('failed', 'boom  boom ')
    const approval = event('approval')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [failed, approval] }), { status: 200 }))
    pageHidden = true
    const notifier = new TaskNotifier(MESSAGES)
    notifier.setTitleResolver(() => undefined)
    const dispose = notifier.start()
    await vi.waitFor(() => expect(shown.length).toBe(2), { timeout: 2000 })
    expect(shown[0]).toEqual({ title: 'Untitled session', body: 'Task failed: boom  boom ' })
    expect(shown[1]).toEqual({ title: 'Untitled session', body: 'Input needed' })
    dispose()
  })

  it('dedupes repeated ids in one batch and resumes from the persisted cursor', async () => {
    const done = event('done')
    // The same event appearing twice in one batch (overlapping fetch / server
    // lag) must notify once only.
    pageHidden = true
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [done, done] }), { status: 200 }))
    const first = new TaskNotifier(MESSAGES)
    const disposeFirst = first.start()
    await vi.waitFor(() => expect(shown.length).toBe(1), { timeout: 2000 })
    disposeFirst()
    expect(Number(storage.get('dsh-mobile-notify-cursor'))).toBe(done.time)
    // A fresh instance starts from the persisted cursor; the server answers
    // with nothing new and nothing is re-notified.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [] }), { status: 200 }))
    const second = new TaskNotifier(MESSAGES)
    const disposeSecond = second.start()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith(`/mobile-access/notify/pending?since=${String(done.time)}`), { timeout: 2000 })
    expect(shown.length).toBe(1)
    disposeSecond()
  })

  it('does not notify while the document is visible but still advances the cursor', async () => {
    const done = event('done')
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ events: [done] }), { status: 200 }))
    pageHidden = false
    const notifier = new TaskNotifier(MESSAGES)
    const dispose = notifier.start()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(shown.length).toBe(0)
    expect(Number(storage.get('dsh-mobile-notify-cursor'))).toBe(done.time)
    dispose()
  })

  it('registers one browser permission request per start and cleans it up', () => {
    const notifier = new TaskNotifier(MESSAGES)
    const dispose = notifier.start()
    expect(pointerListeners.size).toBe(1)
    dispose()
    expect(pointerListeners.size).toBe(0)
  })

  it('is a silent no-op on fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const notifier = new TaskNotifier(MESSAGES)
    const dispose = notifier.start()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(shown.length).toBe(0)
    dispose()
  })

  it('persists and reads the cursor across instances', () => {
    writeCursor(42)
    expect(readCursor()).toBe(42)
    expect(storage.get('dsh-mobile-notify-cursor')).toBe('42')
  })
})
