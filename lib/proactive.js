/**
 * Proactivity with brakes.
 *
 * A companion that never speaks up feels dead; one that comments on everything
 * is worse. This module turns a small, explicit set of world events into at
 * most one short suggestion per cooldown window:
 *
 *   death > low health > took damage > nightfall > player came close > task done
 *
 * A suggestion is only a *line in the prompt*: the plugin never speaks on its
 * own unless `proactive.speak` is explicitly enabled, and `quiet` suppresses
 * everything. No trigger changes the world.
 */

export const DEFAULT_PROACTIVE = Object.freeze({
  enabled: true,
  speak: false,
  quiet: false,
  cooldownMs: 120_000,
  nearDistance: 8,
})

/** Minecraft day starts at 0; night is roughly 13000–23000. */
export function isNight(timeOfDay) {
  const time = Number(timeOfDay)
  if (!Number.isFinite(time)) return false
  const normalized = ((time % 24_000) + 24_000) % 24_000
  return normalized >= 13_000 && normalized <= 23_000
}

export class ProactiveWatcher {
  /** @param {{ config: Record<string, any> }} options */
  constructor({ config } = {}) {
    this.config = config ?? {}
    this.quiet = this.settings.quiet === true
    this.lastSuggestion = null
    this.lastAt = 0
    this.baseline = { health: null, night: false, near: false, seenSeq: 0, behaviorActive: false }
  }

  get settings() {
    return { ...DEFAULT_PROACTIVE, ...(this.config.proactive ?? {}) }
  }

  setQuiet(quiet) {
    this.quiet = quiet === true
    return this.quiet
  }

  /** Most recent suggestion (may be null), for the prompt line. */
  snapshot() {
    const settings = this.settings
    return {
      enabled: settings.enabled,
      quiet: this.quiet,
      speak: settings.speak,
      cooldownMs: settings.cooldownMs,
      last: this.lastSuggestion,
    }
  }

  /**
   * One guard tick. Returns a suggestion object when something is worth saying,
   * or null. Baselines are always updated, so re-enabling never fires a stale
   * "you got hurt" from five minutes ago.
   *
   * @param {{ bot?: any, behavior?: any, events?: any, followDistance?: number | null }} input
   */
  observe({ bot = null, behavior = null, events = null, followDistance = null } = {}) {
    const settings = this.settings
    const now = Date.now()
    const baseline = this.baseline

    const health = bot?.entity ? Number(bot.health) || 20 : null
    const timeOfDay = bot?.time?.timeOfDay
    const night = isNight(timeOfDay)
    const near = typeof followDistance === 'number' ? followDistance <= settings.nearDistance : false
    const behaviorActive = behavior?.active === true
    const behaviorDone = !behaviorActive && baseline.behaviorActive && behavior?.last?.reason === 'done'

    const death = this.#hasNewEvent(events, 'death')
    const firstObservation = baseline.health === null
    const hurt = health !== null && baseline.health !== null && health <= baseline.health - 4
    const low = health !== null && health <= 6 && (baseline.health === null || baseline.health > 6)
    const nightfall = night && !baseline.night && timeOfDay !== undefined
    const arrived = near && !baseline.near

    baseline.health = health
    baseline.night = night
    baseline.near = near
    baseline.behaviorActive = behaviorActive
    if (events) baseline.seenSeq = events.lastSeq

    if (!settings.enabled || this.quiet) return null
    // The first tick only establishes a baseline: enabling the mode at night
    // must not immediately announce that it is dark.
    if (firstObservation) return null
    if (now - this.lastAt < settings.cooldownMs) return null

    let kind = null
    if (death) kind = 'death'
    else if (low) kind = 'low_health'
    else if (hurt) kind = 'hurt'
    else if (nightfall) kind = 'night'
    else if (arrived) kind = 'arrived'
    else if (behaviorDone) kind = 'task_done'
    if (!kind) return null

    const suggestion = {
      id: `${kind}-${now.toString(36)}`,
      kind,
      text: this.#text(kind, { health, behavior }),
      at: now,
    }
    this.lastAt = now
    this.lastSuggestion = suggestion
    return suggestion
  }

  #hasNewEvent(events, type) {
    if (!events?.items) return false
    return events.items.some((event) => event.type === type && event.seq > this.baseline.seenSeq)
  }

  #text(kind, { health, behavior }) {
    switch (kind) {
      case 'death':
        return '我倒了，马上回来。'
      case 'low_health':
        return `我血量低了（${health ?? '?'}/20），先躲一下。`
      case 'hurt':
        return `你受伤了（生命 ${health ?? '?'}/20），要不要先撤？`
      case 'night':
        return '天黑了，附近会刷怪。'
      case 'arrived':
        return '我在你旁边，有事喊我。'
      case 'task_done':
        return `干完了：${behavior?.last?.progress ?? 0}/${behavior?.last?.target ?? 0} ${behavior?.last?.unit ?? ''}`.trim()
      default:
        return ''
    }
  }
}
