/**
 * Behaviour runner: one autonomous loop at a time, with safety rails.
 *
 * The point of this module is token economy. Instead of the model issuing one
 * tool call per block ("walk here", "dig this", "now this one"), it starts a
 * behaviour once and the bot keeps deciding on its own; events are reported only
 * at start, at progress milestones and when it stops.
 *
 * Everything here is inert until `start()` is called: loading the plugin never
 * creates a runner loop, and an unloaded/disconnected bot simply refuses.
 */
import { EventLog } from '../events.js'
import explore from './explore.js'
import fight from './fight.js'
import mine from './mine.js'
import woodcut from './woodcut.js'

/** Registered behaviours, keyed by the `mode` argument of `mc_behavior`. */
export const BEHAVIORS = new Map([explore, woodcut, mine, fight].map((behavior) => [behavior.mode, behavior]))

/** How often the active behaviour gets to make a decision. */
const STEP_INTERVAL_MS = 150
/** Consecutive throws before the behaviour is aborted. */
const MAX_FAILURES = 3
/** Below this target, start/stop events are enough — no milestone spam. */
const MIN_MILESTONE_TARGET = 8

/**
 * @typedef {{ done?: true, reason?: string, progress?: number, note?: string }} StepResult
 */

export class BehaviorRunner {
  /**
   * @param {{ bot: any, config: Record<string, any>, events: EventLog, onStop?: (summary: any) => void }} options
   *   `bot` is the plugin's BotController (not the raw mineflayer bot).
   */
  constructor ({ bot, config, events, onStop }) {
    this.botController = bot
    this.config = config
    this.events = events ?? new EventLog(100)
    this.onStop = onStop
    /** @type {null | { mode: string, instance: any, options: any, startedAt: number, progress: number, target: number, phase: string, note: string, failures: number, timer: any, nextMilestone: number }} */
    this.active = null
    this.generation = 0
    /** @type {Record<string, any> | null} */
    this.last = null
    this.startedCount = 0
  }

  /** Raw mineflayer bot, or null while offline. */
  get bot () {
    return this.botController?.bot ?? null
  }

  /** Which behaviours this profile has explicitly allowed. */
  allowedModes () {
    const allowed = this.config?.behaviors ?? {}
    return Object.keys(allowed).filter((mode) => allowed[mode] === true)
  }

  isAllowed (mode) {
    return this.config?.behaviors?.[mode] === true
  }

  /**
   * Start a behaviour.
   * @param {string} mode one of BEHAVIORS keys
   * @param {Record<string, any>} options
   */
  start (mode, options = {}) {
    const behavior = BEHAVIORS.get(mode)
    if (!behavior) {
      throw new Error(`MC_BEHAVIOR_UNKNOWN: 未知的行为 ${mode}；可用：${[...BEHAVIORS.keys()].join(', ')}。`)
    }
    if (!this.isAllowed(mode)) {
      const allowed = this.allowedModes()
      throw new Error(
        `MC_BEHAVIOR_NOT_ALLOWED: 行为 ${mode} 未在配置中开启（behaviors.${mode}）。` +
        (allowed.length > 0 ? `当前已开启：${allowed.join(', ')}。` : '当前没有开启任何主动行为，需要在插件配置里显式授权。')
      )
    }
    if (!this.bot?.entity) throw new Error('MC_BOT_OFFLINE: Bot 不在线，无法开始行为。先调用 mc_bot_connect。')
    if (this.active) this.stop('replaced')

    const prepared = behavior.prepare({
      bot: this.bot,
      pathfinder: this.botController.pathfinder,
      options: options ?? {},
      config: this.config,
      log: (message, data) => this.#report(message, data)
    })

    this.generation += 1
    const generation = this.generation
    this.active = {
      mode,
      behavior,
      instance: prepared,
      options: options ?? {},
      runId: `${mode}-${Date.now().toString(36)}`,
      startedAt: Date.now(),
      paused: false,
      pausedAt: 0,
      pausedMs: 0,
      pauseReason: '',
      progress: prepared.startProgress ?? 0,
      target: prepared.target ?? 0,
      phase: 'starting',
      note: '',
      failures: 0,
      timer: null,
      // Milestones are a token-economy feature; for short runs the start and
      // stop events are already the whole story.
      nextMilestone: prepared.target >= MIN_MILESTONE_TARGET ? Math.ceil(prepared.target * 0.25) : Infinity,
      generation
    }

    this.startedCount += 1
    const targetText = prepared.target > 0 ? `，目标 ${prepared.target} ${prepared.unit}` : ''
    this.events.push('behavior', `开始${behavior.label}（${mode}${targetText}，半径 ${prepared.radius ?? this.config.behaviorRadius}）`, {
      mode
    })
    this.onStart?.({ ...this.snapshot() })
    this.#schedule(generation)
    return this.snapshot()
  }

  /** Stop the active behaviour (no-op when idle). */
  stop (reason = 'stopped') {
    const active = this.active
    if (!active) return this.last
    this.active = null
    this.generation += 1
    if (active.timer) clearTimeout(active.timer)
    try {
      active.instance?.cleanup?.()
    } catch {
      /* cleanup must never throw into the tool path */
    }
    try {
      if (this.bot?.pathfinder) this.bot.pathfinder.setGoal(null)
    } catch {
      /* pathfinder may be gone with the socket */
    }

    const pausedMs = (active.pausedMs ?? 0) + (active.paused ? Date.now() - active.pausedAt : 0)
    const summary = {
      runId: active.runId,
      mode: active.mode,
      label: active.behavior.label,
      reason,
      paused: active.paused === true,
      pauseReason: active.pauseReason || '',
      progress: active.progress,
      target: active.target,
      unit: active.behavior.unit,
      elapsedMs: Math.max(0, Date.now() - active.startedAt - pausedMs),
    }
    this.last = summary
    const progressText = active.target > 0 ? `${active.progress}/${active.target} ${active.behavior.unit}` : `${active.progress}`
    this.events.push('behavior', `${active.behavior.label}结束（${reason}）：${progressText}，用时 ${Math.round(summary.elapsedMs / 1000)}s`, summary)
    this.onStop?.(summary)
    return summary
  }

  /**
   * Pause the active behaviour without losing progress.
   *
   * This is the interrupt primitive: the loop stops stepping, pathfinding is
   * released so the companion can keep following the player, and `resume()`
   * picks the same run up again. Pausing twice is a no-op.
   */
  pause (reason = 'paused') {
    const active = this.active
    if (!active || active.paused) return this.snapshot()
    active.paused = true
    active.pausedAt = Date.now()
    active.pauseReason = String(reason)
    // Invalidate any tick that is already scheduled or in flight.
    this.generation += 1
    if (active.timer) clearTimeout(active.timer)
    active.timer = null
    try {
      if (this.bot?.pathfinder) this.bot.pathfinder.setGoal(null)
    } catch {
      /* pathfinder may be gone with the socket */
    }
    const progressText = active.target > 0 ? `${active.progress}/${active.target} ${active.behavior.unit}` : `${active.progress}`
    this.events.push('behavior', `${active.behavior.label}已暂停（${reason}）：${progressText}`, {
      mode: active.mode,
      reason: active.pauseReason,
      progress: active.progress,
    })
    return this.snapshot()
  }

  /** Continue a paused behaviour. Throws when there is nothing to resume. */
  resume () {
    const active = this.active
    if (!active) throw new Error('MC_BEHAVIOR_NOT_PAUSED: 当前没有行为可以继续。')
    if (!active.paused) return this.snapshot()
    if (!this.bot?.entity) throw new Error('MC_BOT_OFFLINE: Bot 不在线，无法继续行为。先调用 mc_bot_connect。')
    if ((this.bot.health ?? 20) <= this.config.behaviorMinHealth) {
      throw new Error(`MC_BEHAVIOR_LOW_HEALTH: 生命 ${this.bot.health}/20 低于安全阈值，不能继续；先回血。`)
    }
    active.pausedMs += Date.now() - active.pausedAt
    active.paused = false
    active.pausedAt = 0
    active.pauseReason = ''
    active.failures = 0
    active.phase = 'resumed'
    this.generation += 1
    const generation = this.generation
    this.events.push('behavior', `继续${active.behavior.label}（${active.progress}/${active.target || '?'}）`, {
      mode: active.mode,
      progress: active.progress,
    })
    this.#schedule(generation)
    return this.snapshot()
  }

  /** Compact state for `mc_behavior status` and the live prompt. */
  snapshot () {
    const active = this.active
    if (!active) {
      return { active: false, allowed: this.allowedModes(), last: this.last }
    }
    const pausedMs = (active.pausedMs ?? 0) + (active.paused ? Date.now() - active.pausedAt : 0)
    return {
      active: true,
      runId: active.runId,
      mode: active.mode,
      label: active.behavior.label,
      paused: active.paused === true,
      pauseReason: active.pauseReason || '',
      progress: active.progress,
      target: active.target,
      unit: active.behavior.unit,
      radius: active.instance.radius ?? this.config.behaviorRadius,
      phase: active.phase,
      note: active.note,
      elapsedMs: Math.max(0, Date.now() - active.startedAt - pausedMs),
      allowed: this.allowedModes()
    }
  }

  /** Stop everything; called when the mode is disabled or the plugin unloads. */
  dispose () {
    if (this.active) this.stop('disposed')
    this.generation += 1
  }

  // ---- internals ---------------------------------------------------------

  #schedule (generation) {
    if (generation !== this.generation || !this.active) return
    const timer = setTimeout(() => {
      this.#tick(generation).catch(() => {})
    }, STEP_INTERVAL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    this.active.timer = timer
  }

  async #tick (generation) {
    const active = this.active
    if (!active || generation !== this.generation) return
    // A paused run keeps its state but never steps; resume() reschedules.
    if (active.paused) return

    const stopReason = this.#safetyStop(active)
    if (stopReason) {
      this.stop(stopReason)
      return
    }

    let result = {}
    try {
      result = (await active.instance.step()) ?? {}
    } catch (error) {
      active.failures += 1
      active.note = error instanceof Error ? error.message : String(error)
      if (active.failures >= MAX_FAILURES) {
        this.stop(`error: ${active.note}`.slice(0, 200))
        return
      }
    }
    if (!this.active || generation !== this.generation) return

    if (typeof result.progress === 'number') active.progress = result.progress
    if (result.note) active.note = result.note
    if (result.phase) active.phase = result.phase
    if (result.reason && !result.done) active.phase = result.reason

    if (result.done) {
      this.stop(result.reason ?? 'done')
      return
    }
    if (active.target > 0 && active.progress >= active.nextMilestone) {
      const pct = Math.min(100, Math.round((active.progress / active.target) * 100))
      this.#report(`${active.behavior.label}进度 ${active.progress}/${active.target} ${active.behavior.unit}（${pct}%）`, {
        mode: active.mode,
        progress: active.progress
      })
      active.nextMilestone = active.progress + Math.max(1, Math.ceil(active.target * 0.25))
      if (active.nextMilestone > active.target) active.nextMilestone = Infinity
    }
    active.phase = result.phase ?? (active.instance.idlePhase?.() ?? active.phase)
    this.#schedule(generation)
  }

  /**
   * Hard limits applied before every step. Returns a stop reason, or null.
   */
  #safetyStop (active) {
    const bot = this.bot
    if (!bot?.entity) return 'offline'
    const health = bot.health ?? 20
    if (health <= this.config.behaviorMinHealth) return 'low_health'
    if (active.target > 0 && active.progress >= active.target) return 'done'
    const maxMs = Number(active.options.maxDurationMs ?? this.config.behaviorMaxDurationMs)
    if (maxMs > 0 && Date.now() - active.startedAt > maxMs) return 'time_limit'
    const y = bot.entity.position?.y
    if (typeof y === 'number' && y < -70) return 'out_of_world'
    return null
  }

  #report (message, data) {
    this.events.push('behavior', message, data)
  }
}

