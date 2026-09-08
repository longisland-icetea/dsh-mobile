import { describe, expect, it, vi } from 'vitest'
import { NotifyEventLog, subscribeNotifyEvents } from '../src/notify-events.js'

describe('NotifyEventLog', () => {
  it('records done only on running→idle edges lasting 5s+', () => {
    const log = new NotifyEventLog()
    expect(log.onAgentStatus('s1', 'running')).toBeUndefined()
    expect(log.onAgentStatus('s1', 'idle')).toBeUndefined() // instant flip: noise
    expect(log.since(0)).toHaveLength(0)
  })

  it('emits done after a real run', () => {
    const log = new NotifyEventLog()
    log.onAgentStatus('s1', 'running')
    const state = (log as unknown as { agentState: Map<string, { runningSince: number }> }).agentState
    state.get('s1')!.runningSince -= 6_000
    const event = log.onAgentStatus('s1', 'idle')
    expect(event?.kind).toBe('done')
    expect(event?.sessionId).toBe('s1')
    expect(log.since(0)).toHaveLength(1)
  })

  it('filters by since cursor and prunes entries past TTL', () => {
    const log = new NotifyEventLog()
    const first = log.record('approval', 's1')
    log.record('done', 's2')
    expect(log.since(-1).map(e => e.kind)).toEqual(['approval', 'done'])
    expect(log.since(Number.MAX_SAFE_INTEGER)).toEqual([])
    void first
    const events = (log as unknown as { events: { time: number }[] }).events
    for (const entry of events) entry.time -= 11 * 60 * 1000
    expect(log.since(0)).toHaveLength(0)
  })

  it('caps the buffer at 32 newest', () => {
    const log = new NotifyEventLog()
    for (let index = 0; index < 40; index += 1) log.record('done', `s${index}`)
    expect(log.since(0)).toHaveLength(32)
  })
})

describe('subscribeNotifyEvents', () => {
  it('wires agent/error and approval/asked', () => {
    const log = new NotifyEventLog()
    const handlers: Record<string, (...args: never[]) => void> = {}
    const ctx = { on: vi.fn((event: string, handler: (...args: never[]) => void) => {
      handlers[event] = handler
      return () => undefined
    }) }
    const dispose = subscribeNotifyEvents(ctx as never, log)
    handlers['agent/error']!({ agent: { id: 's9' }, error: new Error('boom x'.repeat(50)) } as never)
    handlers['session/event']!({ id: 's9' } as never, { type: 'approval/asked' } as never)
    handlers['session/event']!({ id: 's9' } as never, { type: 'assistant/message' } as never)
    const kinds = log.since(0).map(e => e.kind).sort()
    expect(kinds).toEqual(['approval', 'failed'])
    expect(log.since(0).find(e => e.kind === 'failed')!.message!.length).toBeLessThanOrEqual(120)
    dispose()
    expect(ctx.on).toHaveBeenCalledTimes(3)
  })
})
