/**
 * Task notifications for paired devices (#46), framework-free.
 *
 * The host records long-task completion/failure/approval events and serves
 * them to paired devices through the gateway; this notifier polls that feed
 * on any authenticated mobile page (phone, narrow or wide desktop browser,
 * or the Android WebView shell) and raises one system notification per event
 * while the document is hidden. Framework-free on purpose: the React layout
 * and any future surface share this single implementation instead of each
 * re-implementing cursor persistence and permission handling.
 *
 * Two delivery paths, selected once per page:
 * - inside the Android app the WebView has no Web Notification API, so the
 *   page hands each event to the shell over `window.__DSH_MOBILE_NATIVE__`
 *   and the shell posts a real system notification;
 * - in browsers, the standard Notification API is used.
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

interface NativeBridge {
  readonly invoke: (action: string, input?: unknown) => Promise<unknown>
}

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
  private readonly supportsNotify: boolean
  private cursor = 0
  private readonly shown = new Set<string>()
  private resolveTitle: ((sessionId: string) => string | undefined) | undefined
  private ensureIssued = false

  constructor(messages: TaskNotifierMessages) {
    this.messages = messages
    // The Android shell counts as a delivery path even though its WebView has
    // no Web Notification API: the page polls and hands events to the shell
    // over __DSH_MOBILE_NATIVE__. The bridge is read lazily (never cached) so
    // a shell that injects it after the page booted is still picked up.
    this.supportsNotify = typeof window !== 'undefined' && typeof window.fetch === 'function'
      && (readNativeBridge() !== undefined || 'Notification' in window)
  }

  /** Prefer a session display name over the generic untitled fallback. */
  setTitleResolver(resolveTitle: (sessionId: string) => string | undefined): void {
    this.resolveTitle = resolveTitle
  }

  /** Begin polling; returns a dispose that stops the loop and listeners. */
  start(): () => void {
    if (!this.supportsNotify) return () => undefined
    this.cursor = readCursor()
    const requestPermission = (): void => {
      if (readNativeBridge() !== undefined || Notification.permission !== 'default') return
      void Notification.requestPermission().catch(() => undefined)
    }
    // Browsers only allow the permission prompt from a user gesture; asking
    // on the first tap anywhere on the page is the least intrusive moment.
    window.addEventListener('pointerdown', requestPermission, { once: true })
    this.ensureNativePermission()
    void this.poll()
    const timer = window.setInterval(() => { void this.poll() }, NOTIFY_POLL_MS)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pointerdown', requestPermission)
    }
  }

  private ensureNativePermission(): void {
    if (this.ensureIssued) return
    const bridge = readNativeBridge()
    if (bridge === undefined) return
    this.ensureIssued = true
    // Ask for the Android 13 runtime permission up front rather than on the
    // first event: events are TTL'd and WebView timers throttle in the
    // background, so waiting would often mean never asking.
    bridge.invoke('notify.ensure').catch(() => undefined)
  }

  private async poll(): Promise<void> {
    this.ensureNativePermission()
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
    const bridge = readNativeBridge()
    const title = this.resolveTitle?.(event.sessionId) ?? this.messages.notifyUntitledSession
    let body: string
    if (event.kind === 'failed') {
      body = typeof event.message === 'string' && event.message !== ''
        ? this.messages.notifyFailedDetail.replace('{message}', event.message)
        : this.messages.notifyFailed
    } else {
      body = event.kind === 'approval' ? this.messages.notifyApproval : this.messages.notifyDone
    }
    if (bridge !== undefined) {
      bridge.invoke('notify.show', { title, body, tag: event.id, sessionId: event.sessionId }).catch(() => undefined)
      return
    }
    if (Notification.permission === 'granted') {
      const notification = new Notification(title, { body, tag: event.id })
      notification.onclick = (): void => { window.focus(); notification.close() }
    }
  }
}

/** Read the native bridge lazily so late shell injection is honored. */
function readNativeBridge(): NativeBridge | undefined {
  try {
    return (window as unknown as { __DSH_MOBILE_NATIVE__?: NativeBridge }).__DSH_MOBILE_NATIVE__
  } catch { return undefined }
}
