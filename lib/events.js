/**
 * Bounded, in-memory event log for the companion bot.
 *
 * Everything the bot observes — chat, health, death, kicks, build progress —
 * lands here. Tools read it (`mc_status`, `mc_events`) and, while the mode is
 * enabled, a compact slice is injected into the model's runtime context so the
 * companion is aware of what happened in game without a round trip.
 *
 * The log intentionally lives only in memory: disabling the mode clears it, so
 * a disabled plugin keeps no Minecraft state anywhere.
 */

/** @typedef {{ seq: number, time: number, type: string, message: string, data?: unknown }} CompanionEvent */

export class EventLog {
  /** @param {number} limit */
  constructor(limit = 500) {
    this.limit = limit
    /** @type {CompanionEvent[]} */
    this.items = []
    this.nextSeq = 1
  }

  /**
   * Append one event.
   * @param {string} type short machine-readable kind, e.g. "chat" or "build_done"
   * @param {string} message human-readable one-liner
   * @param {unknown} [data] optional structured payload
   * @returns {CompanionEvent}
   */
  push(type, message, data) {
    const event = {
      seq: this.nextSeq++,
      time: Date.now(),
      type,
      message,
      ...(data === undefined ? {} : { data }),
    }
    this.items.push(event)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
    return event
  }

  /**
   * Read recent events.
   * @param {{ limit?: number, sinceSeq?: number, typePrefix?: string }} [options]
   * @returns {CompanionEvent[]}
   */
  list(options = {}) {
    const limit = Math.max(1, Math.min(this.limit, Number(options.limit) || 20))
    const sinceSeq = Number(options.sinceSeq) || 0
    const prefix = typeof options.typePrefix === 'string' && options.typePrefix.length > 0
      ? options.typePrefix
      : null
    return this.items
      .filter((event) => event.seq > sinceSeq && (prefix === null || event.type.startsWith(prefix)))
      .slice(-limit)
  }

  /** Most recent N events, newest last. */
  recent(limit = 10) {
    return this.items.slice(-Math.max(1, limit))
  }

  /** Drop everything (used when the mode is disabled). */
  clear() {
    this.items = []
    this.nextSeq = 1
  }

  /** Newest sequence number seen, for incremental reads. */
  get lastSeq() {
    return this.nextSeq - 1
  }
}

/** Format an event for a text tool result. */
export function formatEvent(event, { withData = false } = {}) {
  const time = new Date(event.time).toISOString().slice(11, 19)
  const base = `[${time}] ${event.type}: ${event.message}`
  if (!withData || event.data === undefined) return base
  let payload
  try {
    payload = JSON.stringify(event.data)
  } catch {
    payload = String(event.data)
  }
  return `${base} ${payload.length > 300 ? `${payload.slice(0, 300)}…` : payload}`
}
