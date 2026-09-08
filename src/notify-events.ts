import type { Context } from '@deepseek-ai/cordis'

export type NotifyEventKind = 'done' | 'failed' | 'approval'

export interface NotifyEvent {
  readonly id: string
  readonly sessionId: string
  readonly kind: NotifyEventKind
  readonly time: number
  readonly message?: string
}

export const MAX_NOTIFY_EVENTS = 32
export const NOTIFY_EVENT_TTL_MS = 10 * 60 * 1000

/**
 * In-memory completion/failure/approval events for the phone page,
 * aligned with dsh-messager semantics:
 *
 * - a turn that ran at least MIN_NOTIFY_TOOL_CALLS tools and ended cleanly
 *   is a task completion;
 * - a turn that ended in error is a failure (retries within a step only
 *   append llm/retry and never close the turn, so each failed turn yields
 *   exactly one event; aborted/blocked/max-tokens/interrupted never notify);
 * - approval/asked is an approval request.
 *
 * Only top-level sessions (delegationDepth absent) notify for done/failed;
 * subagent chatter stays silent. Counters are per-turn in memory and reset
 * on every turn/start, so a host restart cannot invent a running state — the
 * crash-orphaned closer (interrupted) simply does not notify. A restart
 * clears the buffer; events reappear on the next qualifying turn.
 */
export class NotifyEventLog {
  private readonly events: NotifyEvent[] = []
  private readonly turnToolCalls = new Map<string, number>()

  record(kind: NotifyEventKind, sessionId: string, message?: string): NotifyEvent {
    const time = Date.now()
    const event: NotifyEvent = {
      id: `${String(time)}:${sessionId}:${kind}`,
      sessionId,
      kind,
      time,
      ...(message === undefined ? {} : { message }),
    }
    this.prune(time)
    this.events.push(event)
    while (this.events.length > MAX_NOTIFY_EVENTS) this.events.shift()
    return event
  }

  onTurnEvent(sessionId: string, type: string, root: boolean, reasonKind?: string, error?: unknown): NotifyEvent | undefined {
    if (type === 'approval/asked') return this.record('approval', sessionId)
    if (type === 'turn/start') {
      this.turnToolCalls.set(sessionId, 0)
      return undefined
    }
    if (type === 'tool/call') {
      this.turnToolCalls.set(sessionId, (this.turnToolCalls.get(sessionId) ?? 0) + 1)
      return undefined
    }
    if (type !== 'turn/end' || !root) return undefined
    const toolCalls = this.turnToolCalls.get(sessionId) ?? 0
    if (reasonKind === 'error') return this.record('failed', sessionId, truncateError(error))
    if (reasonKind === 'completed' && toolCalls >= MIN_NOTIFY_TOOL_CALLS) return this.record('done', sessionId)
    return undefined
  }

  since(since: number): NotifyEvent[] {
    this.prune(Date.now())
    return this.events.filter(event => event.time > since)
  }

  private prune(now: number): void {
    while (this.events.length > 0 && now - (this.events[0]?.time ?? now) > NOTIFY_EVENT_TTL_MS) {
      this.events.shift()
    }
  }
}

/** Long-task floor, matching dsh-messager's default. */
export const MIN_NOTIFY_TOOL_CALLS = 7

const truncateError = (error: unknown): string | undefined => {
  const text = typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : String(error ?? '')
  const clean = text.replace(/\s+/gu, ' ').trim().slice(0, 120)
  return clean === '' ? undefined : clean
}

/** Subscribe the log to host session events; returns a dispose function. */
export function subscribeNotifyEvents(ctx: Context, log: NotifyEventLog): () => void {
  // The supertypes are intentionally wide: SessionEvent is a closed union
  // with per-kind data shapes, so the callback narrows only the turn/end arm.
  return ctx.on('session/event', (session: { readonly id: string; readonly header?: { readonly delegationDepth?: number } }, event: { readonly type: string }) => {
    const root = (session.header?.delegationDepth ?? 0) === 0
    const reason = event.type === 'turn/end'
      ? (event as { data?: { reason?: { kind?: string; error?: unknown } } }).data?.reason
      : undefined
    log.onTurnEvent(session.id, event.type, root, reason?.kind, reason?.error)
  })
}
