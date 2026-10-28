/**
 * Combat: attack configured hostile mobs until `amount` are dead.
 *
 * Safety choices, all deliberate:
 *  - only names in the target list are ever attacked (players are never in it);
 *  - the runner aborts the whole behaviour at `behaviorMinHealth`, so the bot
 *    retreats by stopping instead of fighting to the death;
 *  - creepers are not in the default list (see targets.js).
 */
import { DEFAULT_FIGHT_TARGETS, validateTargets } from './targets.js'
import { clampAmount, clampRadius, distanceTo, shortPosition } from './helpers.js'

const DEFAULT_AMOUNT = 3
const MAX_AMOUNT = 64
const ATTACK_COOLDOWN_MS = 600
const FOLLOW_RANGE = 2.5

export default {
  mode: 'fight',
  label: '打怪',
  unit: '只',

  prepare ({ bot, pathfinder, options, config }) {
    const radius = clampRadius(options.radius, config)
    const amount = clampAmount(options.amount, DEFAULT_AMOUNT, MAX_AMOUNT)
    const names = Array.isArray(options.targets) && options.targets.length > 0
      ? validateTargets(options.targets, (name) => !bot.registry || Boolean(bot.registry.entitiesByName?.[name]), '生物')
      : [...DEFAULT_FIGHT_TARGETS]
    const targets = new Set(names)

    let progress = 0
    let current = null
    let lastAttackAt = 0
    let lastNote = 'scanning for targets'
    let emptyScans = 0
    /** Ids we hit at least once; a disappearing id counts as a kill. */
    const engaged = new Set()

    const onGone = (entity) => {
      if (!entity || !engaged.has(entity.id)) return
      engaged.delete(entity.id)
      progress += 1
      lastNote = `killed ${progress}/${amount}`
      if (current && current.id === entity.id) current = null
    }
    try {
      bot.on('entityGone', onGone)
    } catch {
      /* older mineflayer: counts stay at 0 and the behaviour stops on time */
    }

    const findTarget = () => {
      let best = null
      for (const entity of Object.values(bot.entities ?? {})) {
        if (!entity || entity === bot.entity) continue
        if (!targets.has(entity.name)) continue
        const distance = distanceTo(bot, entity.position)
        if (!(distance <= radius)) continue
        if (!best || distance < best.distance) best = { entity, distance }
      }
      return best
    }

    return {
      target: amount,
      unit: '只',
      radius,
      get startProgress () {
        return progress
      },
      idlePhase: () => lastNote,

      async step () {
        if (progress >= amount) return { done: true, reason: 'done', progress }

        if (!current || !bot.entities?.[current.id]) {
          const found = findTarget()
          if (!found) {
            emptyScans += 1
            lastNote = `no targets within ${radius} blocks`
            if (emptyScans >= 3) return { done: true, reason: 'no_targets', progress, phase: lastNote }
            return { progress, phase: lastNote }
          }
          emptyScans = 0
          current = found.entity
          lastNote = `engaging ${current.name} at ${shortPosition(current.position)}`
        }

        const distance = distanceTo(bot, current.position)
        if (distance > FOLLOW_RANGE + 0.5) {
          if (pathfinder?.goals && bot.pathfinder) {
            try {
              bot.pathfinder.setGoal(new pathfinder.goals.GoalFollow(current, FOLLOW_RANGE), true)
            } catch {
              /* fall through: attack when close enough anyway */
            }
          }
          return { progress, phase: lastNote }
        }

        try {
          bot.pathfinder?.setGoal?.(null)
        } catch {
          /* ignore */
        }

        const now = Date.now()
        if (now - lastAttackAt < ATTACK_COOLDOWN_MS) return { progress, phase: lastNote }
        lastAttackAt = now
        engaged.add(current.id)
        try {
          bot.attack(current)
        } catch (error) {
          lastNote = `attack failed: ${error instanceof Error ? error.message : 'unknown'}`
          current = null
        }
        return { progress, phase: lastNote }
      },

      cleanup () {
        try {
          bot.removeListener('entityGone', onGone)
        } catch {
          /* ignore */
        }
        try {
          bot.pathfinder?.setGoal?.(null)
        } catch {
          /* ignore */
        }
      }
    }
  }
}
