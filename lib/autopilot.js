/**
 * Autopilot: the reflexes the bot keeps when nobody is driving it.
 *
 * This is what makes the companion usable as a *companion*: between model
 * turns it still eats, fights back, runs from danger, picks up drops, respawns
 * and (optionally) catches up with its owner. It never digs, never breaks
 * player builds and never attacks players — those stay explicit decisions.
 *
 * Priority order per tick (higher wins):
 *   respawn → flee → fight back → eat → pick up drops → swim → follow owner
 */
import { DEFAULT_FIGHT_TARGETS } from './behaviors/targets.js'
import { eatFood, findItem, attackNearest } from './actions.js'
import { gotoPosition } from './navigation.js'

const TICK_MS = 500
const HOSTILE_NAMES = new Set(DEFAULT_FIGHT_TARGETS)
/** After taking damage, retaliate/flee for this long. */
const THREAT_MEMORY_MS = 6_000

const DEFAULTS = Object.freeze({
  enabled: true,
  eat: true,
  eatThreshold: 16,
  defend: true,
  flee: true,
  fleeHealth: 6,
  pickup: true,
  pickupRadius: 8,
  respawn: true,
  followOwner: false,
  followOwnerDistance: 16
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class Autopilot {
  /**
   * @param {{ botController: any, config: Record<string, any>, events: any }} options
   */
  constructor ({ botController, config, events }) {
    this.botController = botController
    this.config = config
    this.events = events
    this.options = { ...DEFAULTS, ...(config?.autopilot ?? {}) }
    this.timer = null
    this.busy = false
    this.lastAction = null
    this.lastThreatAt = 0
    this.lastPickupAt = 0
    this.lastFollowAt = 0
    this.lastEatAt = 0
    this.actionCount = 0
    /** Manual navigation (goto/sleep/build) takes precedence over reflexes. */
    this.holds = 0
    /** @type {(() => void) | null} */
    this.detach = null
  }

  get bot () {
    return this.botController?.bot ?? null
  }

  /** Pause reflexes while an explicit navigation/action owns the pathfinder. */
  hold () {
    this.holds += 1
    return this
  }

  /** Release a hold; reflexes resume when the last one is gone. */
  release () {
    this.holds = Math.max(0, this.holds - 1)
    return this
  }

  start () {
    if (this.timer) return this
    this.timer = setInterval(() => this.#tick().catch(() => {}), TICK_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    return this
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      this.detach?.()
    } catch {
      /* ignore */
    }
    this.detach = null
    return this
  }

  /** Merge new switches (used by the UI and by `mc_act autopilot`). */
  setOptions (patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULTS)) continue
      if (key === 'eatThreshold') this.options[key] = Math.max(0, Math.min(20, Number(value) || 0))
      else if (key === 'fleeHealth') this.options[key] = Math.max(1, Math.min(20, Number(value) || 1))
      else if (key === 'pickupRadius' || key === 'followOwnerDistance') this.options[key] = Math.max(2, Math.min(32, Number(value) || 2))
      else this.options[key] = value === true
    }
    this.start()
    return this.snapshot()
  }

  snapshot () {
    return {
      ...this.options,
      running: Boolean(this.timer),
      held: this.holds > 0,
      lastAction: this.lastAction,
      actions: this.actionCount
    }
  }

  // ---- reflexes ---------------------------------------------------------

  /** True when the bot is free to act on its own. */
  #idle () {
    const bot = this.bot
    if (!bot?.entity || bot.health <= 0) return false
    if (bot.isSleeping) return false
    if (this.holds > 0) return false
    if (this.botController?.behaviors?.snapshot?.().active) return false
    if (this.botController?.build && this.botController.build.status === 'running') return false
    return true
  }

  #nearestHostile (radius) {
    const bot = this.bot
    let best = null
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity || entity === bot.entity) continue
      if (entity.type === 'player') continue
      if (!HOSTILE_NAMES.has(entity.name)) continue
      const distance = bot.entity.position.distanceTo(entity.position)
      if (distance > radius) continue
      if (!best || distance < best.distance) best = { entity, distance }
    }
    return best
  }

  #notify (message, data) {
    this.actionCount += 1
    this.lastAction = { at: Date.now(), message }
    this.events?.push?.('autopilot', message, data)
  }

  /** (Re)attach the damage listener when the underlying bot instance changes. */
  #attach (bot) {
    if (!bot || this.attachedBot === bot) return
    try {
      this.detach?.()
    } catch {
      /* ignore */
    }
    const onHurt = (entity) => {
      if (entity && bot.entity && entity.id === bot.entity.id) this.lastThreatAt = Date.now()
    }
    try {
      bot.on('entityHurt', onHurt)
      this.detach = () => bot.removeListener('entityHurt', onHurt)
    } catch {
      this.detach = null
    }
    this.attachedBot = bot
  }

  async #tick () {
    if (this.busy) return
    const options = this.options
    if (!options.enabled) return
    const bot = this.bot
    if (!bot || !bot.entity) return
    this.#attach(bot)

    // 1. Death is always worth handling, even while a behaviour owns the loop.
    if (bot.health <= 0) {
      if (!options.respawn) return
      this.busy = true
      try {
        await bot.respawn().catch(() => {
          try {
            bot._client.write('client_command', { actionId: 0 })
          } catch {
            /* ignore */
          }
        })
        this.#notify('已自动重生')
      } finally {
        this.busy = false
      }
      return
    }

    if (!this.#idle()) return

    const threatened = Date.now() - this.lastThreatAt < THREAT_MEMORY_MS
    const hostile = this.#nearestHostile(8)

    // 2. Flee when badly hurt and something hostile is close.
    if (options.flee && hostile && bot.health <= options.fleeHealth) {
      this.busy = true
      try {
        const away = bot.entity.position.offset(
          (bot.entity.position.x - hostile.entity.position.x) * 2,
          0,
          (bot.entity.position.z - hostile.entity.position.z) * 2
        )
        this.#notify(`血量 ${bot.health}，正在远离 ${hostile.entity.name}`, { entity: hostile.entity.name })
        await gotoPosition(this.botController, {
          x: Math.floor(away.x),
          y: Math.floor(bot.entity.position.y),
          z: Math.floor(away.z),
          tolerance: 3,
          timeoutMs: 4_000
        }).catch(() => null)
      } finally {
        this.busy = false
      }
      return
    }

    // 3. Fight back when attacked (or when a hostile is already in reach).
    if (options.defend && (threatened || (hostile && hostile.distance <= 3))) {
      this.busy = true
      try {
        const hit = await attackNearest(this.botController, { radius: 4 }).catch(() => null)
        if (hit?.ok) this.#notify(`反击 ${hit.target}`, { target: hit.target })
      } finally {
        this.busy = false
      }
      return
    }

    // 4. Eat before the hunger bar becomes a problem.
    if (options.eat && bot.food <= options.eatThreshold && Date.now() - this.lastEatAt > 3_000) {
      const food = bot.inventory.items().find((item) => /(bread|cooked_|_stew|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|berry)/.test(item.name))
      if (food) {
        this.lastEatAt = Date.now()
        this.busy = true
        try {
          const ate = await eatFood(this.botController)
          if (ate?.ok && !ate.skipped) this.#notify(`吃了 ${ate.ate}（饥饿 ${ate.food}）`, { food: ate.food })
        } finally {
          this.busy = false
        }
        return
      }
    }

    // 5. Pick up drops that are lying around.
    if (options.pickup && Date.now() - this.lastPickupAt > 5_000) {
      const drop = Object.values(bot.entities ?? {})
        .filter((entity) => entity?.name === 'item')
        .map((entity) => ({ entity, distance: bot.entity.position.distanceTo(entity.position) }))
        .filter((entry) => entry.distance <= options.pickupRadius)
        .sort((a, b) => a.distance - b.distance)[0]
      if (drop && drop.distance > 1.5) {
        this.lastPickupAt = Date.now()
        this.busy = true
        try {
          await gotoPosition(this.botController, {
            x: Math.floor(drop.entity.position.x),
            y: Math.floor(drop.entity.position.y),
            z: Math.floor(drop.entity.position.z),
            tolerance: 1.5,
            timeoutMs: 5_000
          }).catch(() => null)
        } finally {
          this.busy = false
        }
        return
      }
    }

    // 6. Swim up instead of drowning.
    if ((bot.entity.isInWater || bot.entity.isInLava) && bot.entity.position.y < (bot.entity.position.y + 0.1)) {
      try {
        bot.setControlState('jump', true)
        await sleep(300)
        bot.setControlState('jump', false)
      } catch {
        /* ignore */
      }
      return
    }

    // 7. Catch up with the owner when asked to stay close.
    if (options.followOwner && this.config?.owner && Date.now() - this.lastFollowAt > 4_000) {
      const owner = bot.players?.[this.config.owner]?.entity
      if (owner) {
        const distance = bot.entity.position.distanceTo(owner.position)
        if (distance > options.followOwnerDistance) {
          this.lastFollowAt = Date.now()
          this.busy = true
          try {
            await gotoPosition(this.botController, {
              x: Math.floor(owner.position.x),
              y: Math.floor(owner.position.y),
              z: Math.floor(owner.position.z),
              tolerance: 5,
              timeoutMs: 8_000
            }).catch(() => null)
            this.#notify(`跟上 ${this.config.owner}`, { distance: Math.round(distance) })
          } finally {
            this.busy = false
          }
        }
      }
    }
  }
}

export { DEFAULTS as AUTOPILOT_DEFAULTS }
export const findFoodItem = findItem


