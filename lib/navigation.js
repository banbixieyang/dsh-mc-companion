/**
 * Point-to-point navigation.
 *
 * One explicit destination, walked with mineflayer-pathfinder, and a result that
 * says *why* it failed instead of hanging: the two realistic outcomes on a real
 * server are "arrived" and "cannot get there" (wall, water, unloaded chunk,
 * long-distance terrain). The caller gets the last position and distance so it
 * can decide whether to break the trip into legs.
 *
 * No digging, no pillaring: the pathfinder movements configured in `bot.js`
 * forbid both, so a goto can never modify the world.
 */

const DEFAULT_TOLERANCE = 1.5
const DEFAULT_TIMEOUT_MS = 60_000
/** No progress for this long counts as stuck. */
const STUCK_AFTER_MS = 5_000
/** Ignore sub-block noise when deciding "no progress". */
const PROGRESS_EPSILON = 0.5

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const vec = (position) => ({
  x: Math.round(position.x * 100) / 100,
  y: Math.round(position.y * 100) / 100,
  z: Math.round(position.z * 100) / 100
})

/**
 * Walk to an absolute position.
 *
 * @param {any} botController the plugin's BotController
 * @param {{ x?: number, y?: number, z?: number, tolerance?: number, timeoutMs?: number }} options
 * @returns {Promise<Record<string, any>>} `{ ok, from, to, distance, elapsedMs, reason? }`
 */
export async function gotoPosition (botController, options = {}) {
  const bot = botController?.bot
  if (!bot || !bot.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  if (!bot.pathfinder || !botController.pathfinder) throw new Error('MC_PATHFINDER_MISSING: mineflayer-pathfinder 未加载。')

  const target = { x: Number(options.x), y: Number(options.y), z: Number(options.z) }
  if (![target.x, target.y, target.z].every(Number.isFinite)) {
    throw new Error('MC_GOTO_INVALID_ARGS: 需要数字 x / y / z（绝对坐标）。')
  }
  const tolerance = Math.max(0.5, Math.min(6, Number(options.tolerance) || DEFAULT_TOLERANCE))
  const timeoutMs = Math.max(2_000, Math.min(300_000, Number(options.timeoutMs ?? options.timeout_ms) || DEFAULT_TIMEOUT_MS))
  const maxDistance = Math.max(8, Number(botController.config?.gotoMaxDistance) || 128)

  const from = bot.entity.position.clone()
  const straightLine = from.distanceTo(target)
  if (straightLine > maxDistance) {
    return {
      ok: false,
      error: 'MC_GOTO_TOO_FAR',
      message: `目标直线距离 ${straightLine.toFixed(0)} 格，超过单次上限 ${maxDistance} 格；请分段走（每段 <= ${maxDistance} 格）。`,
      from: vec(from),
      to: target,
      distance: Math.round(straightLine * 10) / 10
    }
  }
  if (straightLine <= tolerance) {
    return { ok: true, alreadyThere: true, from: vec(from), to: target, distance: 0, elapsedMs: 0 }
  }

  const { goals } = botController.pathfinder
  const startedAt = Date.now()
  let best = straightLine
  let lastProgressAt = startedAt
  let lastPosition = from

  try {
    bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, tolerance))
  } catch (error) {
    return {
      ok: false,
      error: 'MC_PATHFINDER_FAILED',
      message: error instanceof Error ? error.message : String(error),
      from: vec(from),
      to: target
    }
  }

  try {
    while (true) {
      if (!bot.entity) {
        return { ok: false, error: 'MC_BOT_NOT_CONNECTED', message: '寻路途中 Bot 掉线。', from: vec(from), to: target }
      }
      const now = Date.now()
      const position = bot.entity.position
      const remaining = position.distanceTo(target)

      if (remaining <= tolerance) {
        return {
          ok: true,
          from: vec(from),
          to: target,
          at: vec(position),
          distance: Math.round(remaining * 10) / 10,
          elapsedMs: now - startedAt
        }
      }

      if (remaining < best - PROGRESS_EPSILON) {
        best = remaining
        lastProgressAt = now
        lastPosition = position.clone()
      }

      if (now - startedAt > timeoutMs) {
        return {
          ok: false,
          error: 'MC_GOTO_TIMEOUT',
          message: `走了 ${Math.round((now - startedAt) / 1000)}s 仍未到达（还剩 ${remaining.toFixed(0)} 格）。`,
          from: vec(from),
          to: target,
          at: vec(position),
          distance: Math.round(remaining * 10) / 10
        }
      }
      if (now - lastProgressAt > STUCK_AFTER_MS) {
        const moving = Boolean(bot.pathfinder?.isMoving?.())
        return {
          ok: false,
          error: 'MC_PATH_STUCK',
          message: moving
            ? `原地打转超过 ${Math.round(STUCK_AFTER_MS / 1000)}s，还剩 ${remaining.toFixed(0)} 格；地形可能过不去（水/墙/断层），建议换目标点或分段。`
            : `寻路已停止但没到目的地，还剩 ${remaining.toFixed(0)} 格；路径不可达（墙/水/未加载区块）。`,
          from: vec(from),
          to: target,
          at: vec(position),
          lastProgressAt: vec(lastPosition),
          distance: Math.round(remaining * 10) / 10
        }
      }
      await sleep(250)
    }
  } finally {
    try {
      bot.pathfinder.setGoal(null)
    } catch {
      /* ignore */
    }
  }
}
