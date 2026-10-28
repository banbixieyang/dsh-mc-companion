/**
 * Block interaction: sleeping (which is also how a bed becomes the respawn
 * point) and activating the small set of blocks that are safe to poke.
 *
 * Deliberately narrow: containers and machine blocks are refused, because
 * "open it" is not something a companion should do without a dedicated tool and
 * an explicit user instruction. Sleeping is the exception — it is how the bot
 * gets a spawn point, and it cannot damage anything.
 */

import vec3Pkg from 'vec3'

const { Vec3 } = vec3Pkg

/** Blocks that may be activated. Anything else is refused with a clear error. */
const ACTIVATABLE = [
  /_button$/,
  /^lever$/,
  /_door$/,
  /_trapdoor$/,
  /_fence_gate$/,
  /^bell$/,
  /_pressure_plate$/,
  /^note_block$/
]

/** Anything matching this is a storage/container and is never "used". */
const CONTAINERS = [
  /(^|_)chest$/,
  /_shulker_box$/,
  /^barrel$/,
  /^hopper$/,
  /^dispenser$/,
  /^dropper$/,
  /^furnace$/,
  /^blast_furnace$/,
  /^smoker$/,
  /^brewing_stand$/,
  /^crafter$/,
  /^chiseled_bookshelf$/,
  /^decorated_pot$/
]

const BUILTIN_HELPERS = {
  isBed: (name) => typeof name === 'string' && /_bed$/.test(name),
  isActivatable: (name) => typeof name === 'string' && ACTIVATABLE.some((pattern) => pattern.test(name)),
  isContainer: (name) => typeof name === 'string' && CONTAINERS.some((pattern) => pattern.test(name))
}

export const { isBed, isActivatable, isContainer } = BUILTIN_HELPERS

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const round = (value) => Math.round(value * 10) / 10
const vec = (position) => ({ x: round(position.x), y: round(position.y), z: round(position.z) })

/**
 * Sleep in the nearest (or given) bed. Sleeping is what makes the server store
 * the bed as the respawn point, so this doubles as "bind spawn here".
 *
 * @param {any} botController
 * @param {{ x?: number, y?: number, z?: number, radius?: number }} options
 */
export async function sleepInBed (botController, options = {}) {
  const bot = botController?.bot
  if (!bot || !bot.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  if (bot.isSleeping) return { ok: true, slept: true, alreadySleeping: true }

  const hasCoordinates = [options.x, options.y, options.z].every((value) => Number.isFinite(Number(value)))
  let bed = null
  if (hasCoordinates) {
    bed = bot.blockAt(new Vec3(Math.floor(Number(options.x)), Math.floor(Number(options.y)), Math.floor(Number(options.z))))
    if (!bed || !isBed(bed.name)) {
      return {
        ok: false,
        error: 'BED_NOT_FOUND',
        message: `坐标上没有床（读到 ${bed?.name ?? '未加载区块'}），请给床的方块坐标。`
      }
    }
  } else {
    const radius = Math.max(2, Math.min(16, Number(options.radius) || 8))
    const found = bot.findBlocks({ matching: (block) => isBed(block?.name), maxDistance: radius, count: 8 })
      .map((position) => ({ position, block: bot.blockAt(position) }))
      .filter((entry) => entry.block && isBed(entry.block.name))
      .sort((a, b) => a.block.position.distanceTo(bot.entity.position) - b.block.position.distanceTo(bot.entity.position))
    bed = found[0]?.block ?? null
    if (!bed) {
      return {
        ok: false,
        error: 'BED_NOT_FOUND',
        message: `半径 ${radius} 格内没有床；请先放床，或给出床的坐标。`
      }
    }
  }

  // Walk to the bed if needed.
  const reach = Number(botController.config?.reach) || 4.2
  if (bot.entity.position.distanceTo(bed.position) > reach - 0.5) {
    if (!bot.pathfinder || !botController.pathfinder) {
      return { ok: false, error: 'MC_PATHFINDER_MISSING', message: 'mineflayer-pathfinder 未加载，无法走到床边。' }
    }
    try {
      const { goals } = botController.pathfinder
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)),
        sleep(15_000).then(() => {
          throw new Error('path_timeout')
        })
      ])
      bot.pathfinder.setGoal(null)
    } catch (error) {
      return {
        ok: false,
        error: 'BED_UNREACHABLE',
        message: `走不到床边：${error instanceof Error ? error.message : '寻路失败'}`
      }
    }
  }

  // Capture the server's explanation ("You can only sleep at night…"), because
  // that is the useful part of a refused sleep.
  let serverMessage = null
  const onMessage = (text) => {
    serverMessage = String(text)
  }
  try {
    bot.on('messagestr', onMessage)
  } catch {
    /* ignore */
  }

  try {
    await Promise.race([
      bot.sleep(bed),
      sleep(8_000).then(() => {
        throw new Error('sleep_timeout')
      })
    ])
    return {
      ok: true,
      slept: true,
      bed: { name: bed.name, position: vec(bed.position) },
      message: '已入睡，服务器已把这张床记为重生点。'
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const hint = serverMessage
      ?? (/night|thunder|day/i.test(reason) ? '床只能在天黑或雷雨时使用；可以等到晚上，或让服务器时间调到夜晚。' : null)
    return {
      ok: false,
      error: 'SLEEP_FAILED',
      message: hint ? `${reason}（${hint}）` : reason,
      bed: { name: bed.name, position: vec(bed.position) }
    }
  } finally {
    try {
      bot.removeListener('messagestr', onMessage)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Activate a safe block (button/lever/door/trapdoor/fence gate/bell/…).
 *
 * @param {any} botController
 * @param {{ x?: number, y?: number, z?: number }} options
 */
export async function activateBlockAt (botController, options = {}) {
  const bot = botController?.bot
  if (!bot || !bot.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  if (![options.x, options.y, options.z].every((value) => Number.isFinite(Number(value)))) {
    throw new Error('MC_USE_INVALID_ARGS: 需要数字 x / y / z（方块坐标）。')
  }
  const position = { x: Math.floor(Number(options.x)), y: Math.floor(Number(options.y)), z: Math.floor(Number(options.z)) }
  const block = bot.blockAt(new Vec3(position.x, position.y, position.z))
  if (!block) {
    return { ok: false, error: 'BLOCK_NOT_LOADED', message: '该坐标所在的区块未加载。' }
  }
  if (isContainer(block.name)) {
    return {
      ok: false,
      error: 'BLOCK_NOT_ALLOWED',
      message: `${block.name} 是容器/机器，插件不会主动打开它；需要的话请显式说明要做什么。`
    }
  }
  if (!isActivatable(block.name)) {
    return {
      ok: false,
      error: 'BLOCK_NOT_ALLOWED',
      message: `${block.name} 不在可交互白名单内（按钮/拉杆/门/活板门/栅栏门/钟/踏板/音符盒）。`
    }
  }

  const reach = Number(botController.config?.reach) || 4.2
  if (bot.entity.position.distanceTo(block.position) > reach) {
    if (!bot.pathfinder || !botController.pathfinder) {
      return { ok: false, error: 'MC_PATHFINDER_MISSING', message: 'mineflayer-pathfinder 未加载，无法靠近方块。' }
    }
    try {
      const { goals } = botController.pathfinder
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)),
        sleep(15_000).then(() => {
          throw new Error('path_timeout')
        })
      ])
      bot.pathfinder.setGoal(null)
    } catch (error) {
      return { ok: false, error: 'BLOCK_UNREACHABLE', message: `走不到方块旁：${error instanceof Error ? error.message : '寻路失败'}` }
    }
  }

  try {
    await bot.activateBlock(block)
    return { ok: true, block: { name: block.name, position: vec(block.position) } }
  } catch (error) {
    return { ok: false, error: 'USE_FAILED', message: error instanceof Error ? error.message : String(error) }
  }
}


