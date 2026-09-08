import { describe, expect, it, vi } from 'vitest'
import { MIN_NOTIFY_TOOL_CALLS, NotifyEventLog, subscribeNotifyEvents } from '../src/notify-events.js'

describe('NotifyEventLog turn semantics', () => {
  it('records done only for completed turns with 7+ tool calls', () => {
    const log = new NotifyEventLog()
    log.onTurnEvent('s1', 'turn/start', true)
    for (let index = 0; index < 3; index += 1) log.onTurnEvent('s1', 'tool/call', true)
    expect(log.onTurnEvent('s1', 'turn/end', true, 'completed')).toBeUndefined() // short turn
    log.onTurnEvent('s1', 'turn/start', true)
    for (let index = 0; index < MIN_NOTIFY_TOOL_CALLS; index += 1) log.onTurnEvent('s1', 'tool/call', true)
    const event = log.onTurnEvent('s1', 'turn/end', true, 'completed')
    expect(event?.kind).toBe('done')
    expect(event?.sessionId).toBe('s1')
    expect(log.since(0)).toHaveLength(1)
  })

  it('records failed for error turns with the trimmed reason message', () => {
    const log = new NotifyEventLog()
    const event = log.onTurnEvent('s1', 'turn/end', true, 'error', { message: `boom ${'x'.repeat(300)}` })
    expect(event?.kind).toBe('failed')
    expect(event?.message!.length).toBeLessThanOrEqual(120)
  })

  it('never notifies aborted/blocked/max-tokens/interrupted endings', () => {
    const log = new NotifyEventLog()
    log.onTurnEvent('s1', 'turn/start', true)
    for (let index = 0; index < 10; index += 1) log.onTurnEvent('s1', 'tool/call', true)
    for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted']) {
      log.onTurnEvent('s1', 'turn/end', true, kind)
    }
    expect(log.since(0)).toHaveLength(0)
  })

  it('stays silent for subagent sessions', () => {
    const log = new NotifyEventLog()
    log.onTurnEvent('child', 'turn/start', false)
    for (let index = 0; index < 12; index += 1) log.onTurnEvent('child', 'tool/call', false)
    expect(log.onTurnEvent('child', 'turn/end', false, 'completed')).toBeUndefined()
    expect(log.onTurnEvent('child', 'turn/end', false, 'error', { message: 'x' })).toBeUndefined()
    expect(log.since(0)).toHaveLength(0)
  })

  it('records approval regardless of depth', () => {
    const log = new NotifyEventLog()
    const event = log.onTurnEvent('child', 'approval/asked', false)
    expect(event?.kind).toBe('approval')
  })

  it('a new turn resets the tool counter (restart immunity)', () => {
    const log = new NotifyEventLog()
    log.onTurnEvent('s1', 'turn/start', true)
    for (let index = 0; index < 12; index += 1) log.onTurnEvent('s1', 'tool/call', true)
    log.onTurnEvent('s1', 'turn/start', true) // host restarted mid-turn: closer emits interrupted, new turn starts fresh
    log.onTurnEvent('s1', 'turn/end', true, 'completed')
    expect(log.since(0)).toHaveLength(0)
  })

  it('drops the per-session counter when a turn settles', () => {
    const log = new NotifyEventLog()
    log.onTurnEvent('s1', 'turn/start', true)
    for (let index = 0; index < 7; index += 1) log.onTurnEvent('s1', 'tool/call', true)
    log.onTurnEvent('s1', 'turn/end', true, 'completed')
    expect(log.since(0).map(e => e.kind)).toEqual(['done'])
    // The settled turn must not leak its counter: a short follow-up turn in
    // the same session (0 tool calls) stays silent instead of inheriting 7.
    log.onTurnEvent('s1', 'turn/start', true)
    log.onTurnEvent('s1', 'turn/end', true, 'completed')
    expect(log.since(0).map(e => e.kind)).toEqual(['done'])
  })

  it('filters by since cursor and prunes past the TTL', () => {
    const log = new NotifyEventLog()
    log.onTurnEvent('a', 'approval/asked', true)
    log.onTurnEvent('b', 'approval/asked', true)
    expect(log.since(-1).map(e => e.kind)).toEqual(['approval', 'approval'])
    expect(log.since(Number.MAX_SAFE_INTEGER)).toEqual([])
    const events = (log as unknown as { events: { time: number }[] }).events
    for (const entry of events) entry.time -= 11 * 60 * 1000
    expect(log.since(0)).toHaveLength(0)
    for (let index = 0; index < 40; index += 1) log.onTurnEvent(`s${index}`, 'approval/asked', true)
    expect(log.since(0)).toHaveLength(40)
  })
})

describe('subscribeNotifyEvents', () => {
  it('routes session events with header depth to the log', () => {
    const log = new NotifyEventLog()
    let handler: ((session: unknown, event: unknown) => void) | undefined
    const ctx = { on: vi.fn((_event: string, fn: (session: unknown, event: unknown) => void) => {
      handler = fn
      return () => undefined
    }) }
    const dispose = subscribeNotifyEvents(ctx as never, log)
    expect(ctx.on).toHaveBeenCalledWith('session/event', expect.any(Function))
    handler!({ id: 'root', header: {} } as never, { type: 'turn/start' } as never)
    for (let index = 0; index < 8; index += 1) {
      handler!({ id: 'root', header: {} } as never, { type: 'tool/call' } as never)
    }
    handler!({ id: 'root', header: {} } as never, { type: 'turn/end', data: { reason: { kind: 'completed' } } } as never)
    handler!({ id: 'kid', header: { delegationDepth: 2 } } as never, { type: 'approval/asked' } as never)
    const events = log.since(0)
    expect(events.map(e => e.kind).sort()).toEqual(['approval', 'done'])
    dispose()
  })
})
