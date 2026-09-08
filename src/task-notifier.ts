/**
 * Task notifications for paired devices (#46), framework-free.
 *
 * The host records long-task completion/failure/approval events and serves
 * them to paired devices through the gateway; this notifier polls that feed
 * on any authenticated mobile page (phone, narrow or wide desktop browser)
 * and raises a browser system notification per event while the document is
 * hidden. Framework-free on purpose: the React layout and any future surface
 * share this single implementation instead of each re-implementing cursor
 * persistence and permission handling.
 */

/** Locale copy for one notifier instance (kept as plain strings). */
export interface TaskNotifierMessages {
  readonly notifyDone: string
  readonly notifyFailed: string
  /** May contain the literal {message} placeholder. */
  readonly notifyFailedDetail: string
  readonly notifyApproval: string
  readonly notifyUntitledSession: string
}

/** Feed endpoint and poll tuning (the server prunes events older than 10 min). */
export const NOTIFY_PENDING_PATH = '/mobile-access/notify/pending'
export const NOTIFY_POLL_MS = 10_000
const NOTIFY_CURSOR_KEY = 'dsh-mobile-notify-cursor'

interface FeedEvent {
  readonly id: string
  readonly sessionId: string
  readonly kind: string
  readonly time: number
  readonly message?: unknown
}

/** @internal exported for tests */
export const readCursor = (): number => {
  try { return Number(window.localStorage.getItem(NOTIFY_CURSOR_KEY) ?? 0) || 0 } catch { return 0 }
}

/** @internal exported for tests */
export const writeCursor = (cursor: number): void => {
  try { window.localStorage.setItem(NOTIFY_CURSOR_KEY, String(cursor)) } catch { /* private mode */ }
}

export class TaskNotifier {
  private readonly messages: TaskNotifierMessages
  private readonly browserSupported: boolean
  private cursor = 0
  private readonly shown = new Set<string>()
  private resolveTitle: ((sessionId: string) => string | undefined) | undefined

  constructor(messages: TaskNotifierMessages) {
    this.messages = messages
    this.browserSupported = typeof window !== 'undefined' && 'Notification' in window && typeof window.fetch === 'function'
  }

  /** Prefer a session display name over the generic untitled fallback. */
  setTitleResolver(resolveTitle: (sessionId: string) => string | undefined): void {
    this.resolveTitle = resolveTitle
  }

  /** Begin polling; returns a dispose that stops the loop and listeners. */
  start(): () => void {
    if (!this.browserSupported) return () => undefined
    this.cursor = readCursor()
    const requestPermission = (): void => {
      if (Notification.permission !== 'default') return
      void Notification.requestPermission().catch(() => undefined)
    }
    // Browsers only allow the permission prompt from a user gesture; asking
    // on the first tap anywhere on the page is the least intrusive moment.
    window.addEventListener('pointerdown', requestPermission, { once: true })
    void this.poll()
    const timer = window.setInterval(() => { void this.poll() }, NOTIFY_POLL_MS)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pointerdown', requestPermission)
    }
  }

  private async poll(): Promise<void> {
    let events: FeedEvent[] = []
    try {
      const response = await window.fetch(`${NOTIFY_PENDING_PATH}?since=${String(this.cursor)}`)
      if (!response.ok) return
      const data: unknown = await response.json()
      if (typeof data !== 'object' || data === null || !Array.isArray((data as { events?: unknown }).events)) return
      events = (data as { events: FeedEvent[] }).events.filter(entry =>
        typeof entry === 'object' && entry !== null
        && typeof entry.id === 'string' && typeof entry.sessionId === 'string'
        && typeof entry.time === 'number')
    } catch { return }
    let advanced = false
    for (const event of events) {
      if (event.time > this.cursor) { this.cursor = event.time; advanced = true }
      if (this.shown.has(event.id)) continue
      this.shown.add(event.id)
      if (document.hidden) this.show(event)
    }
    if (advanced) writeCursor(this.cursor)
  }

  private show(event: FeedEvent): void {
    if (Notification.permission !== 'granted') return
    const title = this.resolveTitle?.(event.sessionId) ?? this.messages.notifyUntitledSession
    let body: string
    if (event.kind === 'failed') {
      body = typeof event.message === 'string' && event.message !== ''
        ? this.messages.notifyFailedDetail.replace('{message}', event.message)
        : this.messages.notifyFailed
    } else {
      body = event.kind === 'approval' ? this.messages.notifyApproval : this.messages.notifyDone
    }
    const notification = new Notification(title, { body, tag: event.id })
    notification.onclick = (): void => { window.focus(); notification.close() }
  }
}
