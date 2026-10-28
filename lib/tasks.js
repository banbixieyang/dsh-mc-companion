/**
 * Task stack for long-running companion work.
 *
 * A companion gets interrupted constantly: the player says something, the bot
 * takes damage, the player walks off. Before this module the plugin had exactly
 * one implicit "current thing" (a behaviour or a build), no notion of pausing,
 * and no way to answer "what were you doing and why did you stop".
 *
 * The stack is deliberately small and boring:
 *   - `begin` pushes a running task, `end` settles it;
 *   - `top` is the innermost task that is still running or paused;
 *   - `snapshot` is what tools and the live prompt show.
 *
 * It owns no bot resources: pausing/cancelling is the caller's job, so this
 * file stays testable without Mineflayer.
 */

/** Settled tasks are kept for the prompt/status, newest last. */
const HISTORY_LIMIT = 20

const LIVE_STATES = new Set(['running', 'paused'])
const SETTLED_STATES = new Set(['done', 'cancelled', 'failed'])

export class TaskStack {
  /** @param {{ events?: { push: (type: string, message: string, data?: unknown) => unknown } | null }} [options] */
  constructor({ events = null } = {}) {
    this.events = events
    /** @type {Array<{ id: string, kind: string, label: string, state: string, startedAt: number, endedAt: number, parentId: string | null, progress: any, note: string }>} */
    this.items = []
    this.nextId = 1
  }

  /**
   * Push a new running task.
   *
   * @param {{ kind?: string, label?: string, id?: string, parentId?: string | null, meta?: Record<string, any> }} [input]
   */
  begin({ kind = 'task', label = '', id = null, parentId = null, meta = {} } = {}) {
    const task = {
      id: id ?? `${kind}-${this.nextId++}`,
      kind: String(kind),
      label: String(label || kind),
      state: 'running',
      startedAt: Date.now(),
      endedAt: 0,
      parentId: parentId ?? this.top()?.id ?? null,
      progress: meta.progress ?? null,
      note: '',
    }
    this.items.push(task)
    this.#trim()
    this.events?.push('task', `任务开始：${task.label}`, { id: task.id, kind: task.kind })
    return task
  }

  /** Task by id, newest first. */
  get(id) {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (this.items[i].id === id) return this.items[i]
    }
    return null
  }

  /** Innermost task that is still running or paused. */
  top() {
    for (let i = this.items.length - 1; i >= 0; i -= 1) {
      if (LIVE_STATES.has(this.items[i].state)) return this.items[i]
    }
    return null
  }

  /** Patch a live task. Unknown ids are ignored (a race with `end` is fine). */
  update(id, patch = {}) {
    const task = this.get(id)
    if (!task || !LIVE_STATES.has(task.state)) return null
    Object.assign(task, patch)
    return task
  }

  /** Settle a task: done / cancelled / failed. Idempotent. */
  end(id, state = 'done', note = '') {
    const task = this.get(id)
    if (!task || !LIVE_STATES.has(task.state)) return null
    task.state = SETTLED_STATES.has(state) ? state : 'done'
    task.endedAt = Date.now()
    if (note) task.note = String(note)
    this.events?.push('task', `任务结束：${task.label}（${task.state}${task.note ? `：${task.note}` : ''}）`, {
      id: task.id,
      state: task.state,
    })
    return task
  }

  /** Compact view for `mc_status` and the live prompt. */
  snapshot() {
    const current = this.top()
    return {
      depth: this.items.filter((task) => LIVE_STATES.has(task.state)).length,
      current: current
        ? {
            id: current.id,
            kind: current.kind,
            label: current.label,
            state: current.state,
            note: current.note,
            progress: current.progress,
            elapsedMs: Date.now() - current.startedAt,
          }
        : null,
      recent: this.items.slice(-5).map((task) => ({
        id: task.id,
        kind: task.kind,
        label: task.label,
        state: task.state,
        note: task.note,
      })),
    }
  }

  /** Drop everything without emitting events (used on disable/unload). */
  clear() {
    this.items = []
  }

  #trim() {
    if (this.items.length > HISTORY_LIMIT) this.items.splice(0, this.items.length - HISTORY_LIMIT)
  }
}
