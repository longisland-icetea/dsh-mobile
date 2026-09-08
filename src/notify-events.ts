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
const MIN_RUN_MS = 5_000

/**
 * In-memory completion/failure/approval events for the phone page.
 * Same trigger semantics as dsh-messager (agent running→idle, agent/error,
 * approval/asked) but served to paired devices so the remote page can pop
 * a notification; a restart clears it (events reappear on the next run).
 */
export class NotifyEventLog {
  private readonly events: NotifyEvent[] = []
  private readonly agentState = new Map<string, { status: string; runningSince: number }>()

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

  onAgentStatus(agentId: string, status: string): NotifyEvent | undefined {
    const now = Date.now()
    const previous = this.agentState.get(agentId)
    if (status === 'running') {
      if (previous?.status !== 'running') this.agentState.set(agentId, { status, runningSince: now })
      return undefined
    }
    this.agentState.set(agentId, { status, runningSince: previous?.runningSince ?? now })
    if (previous?.status === 'running' && now - previous.runningSince >= MIN_RUN_MS) {
      return this.record('done', agentId)
    }
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

const truncateMessage = (value: unknown): string | undefined => {
  const text = typeof value === 'object' && value !== null && 'message' in value
    ? String((value as { message?: unknown }).message ?? value)
    : String(value ?? '')
  const clean = text.replace(/\s+/gu, ' ').trim().slice(0, 120)
  return clean === '' ? undefined : clean
}

/** Subscribe the log to host agent/session events; returns a dispose function. */
export function subscribeNotifyEvents(ctx: Context, log: NotifyEventLog): () => void {
  const disposables: (() => void)[] = []
  disposables.push(ctx.on('agent/status', (payload: { agent: { id: string }; status: string }) => {
    log.onAgentStatus(payload.agent.id, payload.status)
  }))
  disposables.push(ctx.on('agent/error', (payload: { agent: { id: string }; error?: unknown }) => {
    log.record('failed', payload.agent.id, truncateMessage(payload.error))
  }))
  disposables.push(ctx.on('session/event', (session: { id: string }, event: { type: string }) => {
    if (event.type === 'approval/asked') log.record('approval', session.id)
  }))
  return () => { for (const dispose of disposables) dispose() }
}
