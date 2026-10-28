/**
 * Woodcutting: chop nearby tree blocks until `amount` logs are gone.
 *
 * Trees are the one case where digging is obviously wanted, so the matcher only
 * accepts log/wood/stem/hyphae names — planks, leaves and player builds never
 * match, and the shared blacklist still applies.
 */
import { isLogBlock } from './targets.js'
import { clampAmount, clampRadius, digBlock, findDigTarget, shortPosition } from './helpers.js'

const DEFAULT_AMOUNT = 8
const MAX_AMOUNT = 128
/** Positions that failed three times are ignored for the rest of the run. */
const MAX_ATTEMPTS = 3

export default {
  mode: 'woodcut',
  label: '伐木',
  unit: '个原木',

  prepare ({ bot, pathfinder, options, config }) {
    const radius = clampRadius(options.radius, config)
    const amount = clampAmount(options.amount, DEFAULT_AMOUNT, MAX_AMOUNT)
    const blacklist = Array.isArray(config.behaviorDigBlacklist) ? config.behaviorDigBlacklist : []
    const protectPlayers = config.behaviorProtectPlayers !== false
    const attempts = new Map()
    const avoided = new Set()

    let progress = 0
    let current = null
    let emptyScans = 0
    let lastNote = 'searching'

    return {
      target: amount,
      unit: '个原木',
      radius,
      get startProgress () {
        return progress
      },
      idlePhase: () => lastNote,

      async step () {
        if (progress >= amount) return { done: true, reason: 'done', progress }

        if (!current) {
          const found = findDigTarget(bot, {
            matcher: isLogBlock,
            radius,
            blacklist,
            protectPlayers,
            protectDistance: Number(config.behaviorProtectDistance) || 3,
            avoid: avoided
          })
          if (!found) {
            emptyScans += 1
            lastNote = 'no_trees'
            // One scan can miss trees just outside the loaded area; two is enough.
            if (emptyScans >= 2) return { done: true, reason: 'no_trees', progress, phase: lastNote }
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
        lastNote = `chopped ${progress}/${amount}`
        return { progress, phase: lastNote, note: lastNote }
      }
    }
  }
}
