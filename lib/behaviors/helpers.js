/**
 * Shared helpers for the autonomous behaviours.
 *
 * Everything here takes the raw mineflayer bot and returns plain data; no
 * behaviour is imported here, so this module stays safe to load at any time.
 */
import { isProtectedBlock, nearOtherPlayer } from './targets.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Clamp a caller-supplied radius to a sane band. */
export function clampRadius (radius, config) {
  const fallback = Number(config?.behaviorRadius) || 32
  const value = Number(radius)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.max(4, Math.min(64, Math.round(value)))
}

/** Clamp a caller-supplied amount (how many units to finish). */
export function clampAmount (amount, fallback, max = 256) {
  const value = Number(amount)
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.min(max, Math.round(value)))
}

/** Block name without the namespace. */
export function blockName (block) {
  return block?.name ?? ''
}

/** Wait helper with timeout. */
export function withTimeout (promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message ?? `timeout after ${ms}ms`)), ms)
      if (typeof timer.unref === 'function') timer.unref()
    })
  ]).finally(() => clearTimeout(timer))
}

/** Distance between the bot and a block position. */
export function distanceTo (bot, position) {
  const own = bot?.entity?.position
  if (!own || !position) return Infinity
  return own.distanceTo(position)
}

/**
 * Server-side block state at a position, or null when the chunk is not loaded.
 * @param {any} bot
 * @param {{x:number,y:number,z:number}} position
 */
export function blockAt (bot, position) {
  try {
    return bot.blockAt(position, false)
  } catch {
    return null
  }
}

/**
 * Nearest diggable block whose name matches, respecting the safety rules.
 *
 * @param {any} bot
 * @param {{ matcher: (name: string) => boolean, radius: number, blacklist: string[], protectPlayers: boolean, protectDistance: number, avoid?: Set<string> }} rules
 * @returns {{ block: any, position: any } | null}
 */
export function findDigTarget (bot, rules) {
  const positions = bot.findBlocks({
    matching: (block) => Boolean(block) && rules.matcher(blockName(block)),
    maxDistance: rules.radius,
    count: 32
  })
  let best = null
  for (const position of positions) {
    const key = `${position.x},${position.y},${position.z}`
    if (rules.avoid?.has(key)) continue
    const block = blockAt(bot, position)
    if (!block || block.name === 'air') continue
    if (!rules.matcher(blockName(block))) continue
    if (isProtectedBlock(blockName(block), rules.blacklist)) continue
    if (rules.protectPlayers && nearOtherPlayer(bot, position, rules.protectDistance)) continue
    if (!bot.canDigBlock(block)) continue
    const distance = distanceTo(bot, position)
    if (!best || distance < best.distance) best = { block, position, distance }
  }
  return best
}

/**
 * Walk to a block and dig it, with a bounded attempt count.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function digBlock (bot, pathfinder, block, options = {}) {
  const reach = Number(options.reach) || 4.2
  const digTimeoutMs = Number(options.digTimeoutMs) || 15_000
  const pathTimeoutMs = Number(options.pathTimeoutMs) || 20_000
  const distance = distanceTo(bot, block.position)

  if (distance > reach) {
    if (!pathfinder?.goals) return { ok: false, reason: 'no_pathfinder' }
    try {
      await withTimeout(
        bot.pathfinder.goto(new pathfinder.goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)),
        pathTimeoutMs,
        'path_timeout'
      )
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'path_failed' }
    }
    try {
      bot.pathfinder.setGoal(null)
    } catch {
      /* ignore */
    }
  }

  if (!bot.canDigBlock(block)) return { ok: false, reason: 'cannot_dig' }
  if (distanceTo(bot, block.position) > reach) return { ok: false, reason: 'too_far' }

  // Verify the break actually happened. Some protocol/version combinations make
  // the client believe the dig finished while the server silently ignores it
  // (a stale dig sequence, an aborted dig, a ghost block). Counting that as
  // progress is how a bot ends up reporting "3/3 chopped" on an untouched tree.
  const digest = async () => {
    try {
      await withTimeout(bot.dig(block, true), digTimeoutMs, 'dig_timeout')
      return null
    } catch (error) {
      try {
        bot.stopDigging()
      } catch {
        /* ignore */
      }
      return error instanceof Error ? error.message : 'dig_failed'
    }
  }

  let lastError = await digest()
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(attempt === 0 ? 400 : 700)
    const now = bot.blockAt(block.position)
    if (!now || now.name !== block.name) return { ok: true }
    if (attempt === 2) break
    lastError = await digest()
  }
  const still = bot.blockAt(block.position)
  if (!still || still.name !== block.name) return { ok: true }
  return { ok: false, reason: lastError ?? 'dig_rejected' }
}

/** Human-readable relative path helper used in notes. */
export function shortPosition (position) {
  if (!position) return '?'
  return `${Math.round(position.x)},${Math.round(position.y)},${Math.round(position.z)}`
}

/** Normalise a minecraft-data name lookup: registry may be absent in tests. */
export function registryHas (bot, kind, name) {
  const registry = bot?.registry
  if (!registry) return true
  const table = kind === 'block' ? registry.blocksByName : registry.entitiesByName
  if (!table) return true
  return Boolean(table[name])
}




