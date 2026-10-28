/**
 * Mining: dig a configured set of ores until `amount` are collected.
 *
 * Differences from woodcutting: the target list is validated against the block
 * registry (so a typo cannot mean "mine everything"), and survival players
 * without a pickaxe are told to get one instead of grinding stone with a fist.
 */
import { DEFAULT_ORES, validateTargets } from './targets.js'
import { clampAmount, clampRadius, digBlock, findDigTarget, shortPosition } from './helpers.js'

const DEFAULT_AMOUNT = 8
const MAX_AMOUNT = 128
const MAX_ATTEMPTS = 3

export default {
  mode: 'mine',
  label: '采矿',
  unit: '个矿石',

  prepare ({ bot, pathfinder, options, config }) {
    const radius = clampRadius(options.radius, config)
    const amount = clampAmount(options.amount, DEFAULT_AMOUNT, MAX_AMOUNT)
    const names = Array.isArray(options.targets) && options.targets.length > 0
      ? validateTargets(options.targets, (name) => !bot.registry || Boolean(bot.registry.blocksByName?.[name]), '方块')
      : [...DEFAULT_ORES]
    const targets = new Set(names)
    const blacklist = Array.isArray(config.behaviorDigBlacklist) ? config.behaviorDigBlacklist : []
    const protectPlayers = config.behaviorProtectPlayers !== false
    const attempts = new Map()
    const avoided = new Set()

    let progress = 0
    let current = null
    let emptyScans = 0
    let lastNote = 'searching'

    // Survival without a pickaxe cannot break stone-class blocks at all.
    const needsPickaxe = String(bot.game?.gameMode ?? 'survival') !== 'creative'
    const holdingPickaxe = /_pickaxe$/.test(String(bot.heldItem?.name ?? ''))

    return {
      target: amount,
      unit: '个矿石',
      radius,
      get startProgress () {
        return progress
      },
      idlePhase: () => lastNote,

      async step () {
        if (needsPickaxe && !holdingPickaxe) {
          return { done: true, reason: 'need_pickaxe', progress, phase: 'need_pickaxe' }
        }
        if (progress >= amount) return { done: true, reason: 'done', progress }

        if (!current) {
          const found = findDigTarget(bot, {
            matcher: (name) => targets.has(name),
            radius,
            blacklist,
            protectPlayers,
            protectDistance: Number(config.behaviorProtectDistance) || 3,
            avoid: avoided
          })
          if (!found) {
            emptyScans += 1
            lastNote = `no_targets (${[...targets].slice(0, 3).join('/')}…)`
            if (emptyScans >= 2) return { done: true, reason: 'no_targets', progress, phase: lastNote }
            return { progress, phase: lastNote }
          }
          emptyScans = 0
          current = found
        }

        const key = shortPosition(current.position)
        const result = await digBlock(bot, pathfinder, current.block, {
          reach: config.reach,
          digTimeoutMs: 20_000,
          pathTimeoutMs: 20_000
        })
        if (!result.ok) {
          const count = (attempts.get(key) ?? 0) + 1
          attempts.set(key, count)
          if (count >= MAX_ATTEMPTS) avoided.add(`${current.position.x},${current.position.y},${current.position.z}`)
          current = null
          lastNote = `retry: ${result.reason}`
          return { progress, phase: lastNote, note: lastNote }
        }

        progress += 1
        current = null
        lastNote = `mined ${progress}/${amount}`
        return { progress, phase: lastNote, note: lastNote }
      }
    }
  }
}
