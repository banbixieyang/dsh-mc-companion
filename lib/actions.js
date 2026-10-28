/**
 * Player actions.
 *
 * Everything a player can do that does not already have a dedicated tool
 * (behaviour, goto, sleep, build) lives here: inventory, equipment, eating,
 * dropping, breaking, placing, using items, attacking, containers, crafting,
 * smelting and respawning.
 *
 * Two rules the whole module follows:
 *  - it refuses instead of guessing (no recipe, no space, protected block);
 *  - it never touches player-blocking things (containers are only opened when
 *    asked, and blocks on the safety list are never broken).
 */
import vec3Pkg from 'vec3'
import { isProtectedBlock, nearOtherPlayer } from './behaviors/targets.js'

const { Vec3 } = vec3Pkg
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value) => Math.round(value * 10) / 10
const vec = (position) => ({ x: round(position.x), y: round(position.y), z: round(position.z) })

const ARMOR_DESTINATIONS = { head: 'head', helmet: 'head', torso: 'torso', chest: 'torso', chestplate: 'torso', legs: 'legs', leggings: 'legs', feet: 'feet', boots: 'feet', 'off-hand': 'off-hand', offhand: 'off-hand', hand: 'hand' }

export const FOODS = /(bread|cooked_|_stew|_soup|apple|carrot|potato|beetroot|melon_slice|pumpkin_pie|cookie|cake|beef|porkchop|chicken|mutton|rabbit|salmon|cod|tropical_fish|pufferfish|berry|berries|honey_bottle|dried_kelp|chorus_fruit|golden_apple|enchanted_golden_apple)$/

const fail = (error, message, extra = {}) => ({ ok: false, error, message, ...extra })

/** Find an inventory item by name (namespace optional). */
export function findItem (bot, name) {
  const wanted = String(name ?? '').replace(/^minecraft:/, '')
  return bot.inventory.items().find((item) => item.name === wanted) ?? null
}

/**
 * Compact inventory view for the model / UI.
 * @param {any} bot mineflayer bot
 * @param {{ limit?: number }} [options]
 */
export function inventorySummary (bot, options = {}) {
  if (!bot?.inventory) return { held: null, armor: {}, counts: {}, items: [] }
  const items = bot.inventory.items()
  const counts = {}
  for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count
  const armor = {}
  for (const [slot, item] of Object.entries(bot.inventory.slots ?? {})) {
    const index = Number(slot)
    if (index >= 5 && index <= 8 && item) armor[[5, 6, 7, 8].includes(index) ? ['head', 'torso', 'legs', 'feet'][index - 5] : 'other'] = item.name
  }
  const held = bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null
  const limit = Math.max(5, Math.min(60, Number(options.limit) || 20))
  return {
    held,
    armor,
    counts: {
      food: items.filter((item) => FOODS.test(item.name)).reduce((n, item) => n + item.count, 0),
      blocks: items.filter((item) => /(_planks|_log|^stone$|^cobblestone$|^dirt$|^sand$|^glass$|_wool)$/.test(item.name)).reduce((n, item) => n + item.count, 0),
      tools: items.filter((item) => /_(pickaxe|axe|shovel|sword|hoe)$/.test(item.name)).length,
      total: items.reduce((n, item) => n + item.count, 0)
    },
    freeSlots: bot.inventory.emptySlotCount?.() ?? null,
    items: items.slice(0, limit).map((item) => ({ name: item.name, count: item.count, slot: item.slot })),
    truncated: items.length > limit
  }
}

/** Equip a tool/armour piece by name, or the best one for a destination. */
export async function equipItem (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const destination = ARMOR_DESTINATIONS[String(options.destination ?? options.slot ?? 'hand')]
  if (!destination) return fail('MC_INVENTORY_INVALID_ARGS', 'destination 只能是 hand / head / torso / legs / feet / off-hand。')

  let item = options.item ? findItem(bot, options.item) : null
  if (!item && destination !== 'hand') {
    // Pick the first item that belongs there (armour).
    const pattern = { head: /helmet$|_skull$|pumpkin$/, torso: /chestplate$|elytra$/, legs: /leggings$/, feet: /boots$/ }[destination]
    item = bot.inventory.items().find((entry) => pattern?.test(entry.name)) ?? null
  }
  if (!item && destination === 'hand') item = bot.inventory.items().find((entry) => /_(pickaxe|axe|sword|shovel|hoe)$/.test(entry.name)) ?? null
  if (!item) return fail('ITEM_NOT_FOUND', `背包里没有可用于 ${destination} 的物品。`, { inventory: inventorySummary(bot) })

  await bot.equip(item, destination)
  return { ok: true, equipped: item.name, destination }
}

/** Eat whatever food is held (or the first food found). */
export async function eatFood (botController) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  let food = bot.heldItem && FOODS.test(bot.heldItem.name) ? bot.heldItem : null
  if (!food) food = bot.inventory.items().find((item) => FOODS.test(item.name)) ?? null
  if (!food) return fail('NO_FOOD', '背包里没有食物。')
  if (bot.food >= 20 && !botController?.config?.autopilot?.forceEat) {
    // Eating at full hunger still works but wastes food; say so instead of doing it.
    return { ok: true, skipped: true, message: '饥饿值已满，没有进食。', food: bot.food }
  }
  if (bot.heldItem?.name !== food.name) await bot.equip(food, 'hand')
  await bot.consume()
  return { ok: true, ate: food.name, food: bot.food, health: bot.health }
}

/** Drop items by name (or the held stack). */
export async function dropItem (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const count = Math.max(1, Math.min(2304, Number(options.count) || 1))
  const item = options.item ? findItem(bot, options.item) : bot.heldItem
  if (!item) return fail('ITEM_NOT_FOUND', '背包里没有该物品。')
  await bot.toss(item.type, null, Math.min(count, item.count))
  return { ok: true, dropped: item.name, count: Math.min(count, item.count) }
}

/** Break a block, refusing protected blocks and blocks next to other players. */
export async function breakBlockAt (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const position = new Vec3(Math.floor(Number(options.x)), Math.floor(Number(options.y)), Math.floor(Number(options.z)))
  if (![position.x, position.y, position.z].every(Number.isFinite)) return fail('MC_ACT_INVALID_ARGS', '需要数字 x / y / z。')
  const block = bot.blockAt(position)
  const force = options.force === true
  if (!block || block.name === 'air') return fail('BLOCK_NOT_LOADED', '该坐标没有方块（或区块未加载）。')
  // Two policy checks are skippable by an explicit user override. "Chunk not
  // loaded" and "this tool cannot break it" are engine facts, not policy.
  if (!force) {
    if (isProtectedBlock(block.name)) return fail('BLOCK_PROTECTED', `${block.name} 在保护名单里，不会破坏（需要时用 force:true）。`)
    if (nearOtherPlayer(bot, position, Number(botController.config?.behaviorProtectDistance) || 3)) {
      return fail('BLOCK_NEAR_PLAYER', '其他玩家附近不破坏方块（需要时用 force:true）。')
    }
  }
  const reach = Number(botController.config?.reach) || 4.2
  if (bot.entity.position.distanceTo(position) > reach) {
    const nav = await import('./navigation.js')
    const walked = await nav.gotoPosition(botController, { x: position.x, y: position.y, z: position.z, tolerance: 3, timeoutMs: 20_000, force })
    if (!walked.ok) return fail('BLOCK_UNREACHABLE', `走不到方块旁：${walked.error}`, { nav: walked })
  }
  if (!bot.canDigBlock(block)) return fail('CANNOT_DIG', `${block.name} 挖不动（工具或权限不足）。`)
  await bot.dig(block, true)
  return { ok: true, broke: block.name, position: vec(position), forced: force }
}

/** Place the held block against a reference block. */
export async function placeBlockAt (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const position = new Vec3(Math.floor(Number(options.x)), Math.floor(Number(options.y)), Math.floor(Number(options.z)))
  if (![position.x, position.y, position.z].every(Number.isFinite)) return fail('MC_ACT_INVALID_ARGS', '需要数字 x / y / z。')
  const force = options.force === true
  const existing = bot.blockAt(position)
  if (!force && existing && existing.name !== 'air' && !/water|lava|grass|snow/.test(existing.name)) {
    return fail('BLOCK_OCCUPIED', `${position.x},${position.y},${position.z} 已经有 ${existing.name}（需要时用 force:true）。`)
  }
  if (options.item) {
    const wanted = findItem(bot, options.item)
    if (!wanted) return fail('ITEM_NOT_FOUND', `背包里没有 ${options.item}。`)
    if (bot.heldItem?.name !== wanted.name) await bot.equip(wanted, 'hand')
  }
  if (!bot.heldItem || /_pickaxe$|_axe$|_sword$|_shovel$|_hoe$/.test(bot.heldItem.name)) {
    return fail('NOT_A_BLOCK', '手上不是可放置的方块；先用 item 指定，或 equip 一个方块。', { held: bot.heldItem?.name ?? null })
  }

  // A reference block is required by placeBlock: pick any adjacent solid block.
  const offsets = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  for (const [dx, dy, dz] of offsets) {
    const reference = bot.blockAt(position.offset(dx, dy, dz))
    if (!reference || reference.name === 'air' || reference.name === 'water') continue
    const face = new Vec3(-dx, -dy, -dz)
    try {
      await bot.placeBlock(reference, face)
      return { ok: true, placed: bot.heldItem?.name ?? null, position: vec(position), forced: force }
    } catch (error) {
      return fail('PLACE_FAILED', error instanceof Error ? error.message : String(error))
    }
  }
  return fail('NO_SUPPORT', '目标位置没有可依附的方块。')
}

/** Use the held item (bucket, bow, food, bone meal…). */
export async function useHeldItem (botController) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  if (!bot.heldItem) return fail('NOTHING_HELD', '手上没有物品。')
  await bot.activateItem()
  return { ok: true, used: bot.heldItem.name }
}

/** Attack the nearest matching entity, once. */
export async function attackNearest (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const radius = Math.max(2, Math.min(32, Number(options.radius) || 4))
  const targets = Array.isArray(options.targets) && options.targets.length > 0
    ? options.targets.map((name) => String(name).replace(/^minecraft:/, ''))
    : null
  let best = null
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity === bot.entity) continue
    if (entity.type === 'player') continue // never attack players
    if (targets && !targets.includes(entity.name)) continue
    const distance = bot.entity.position.distanceTo(entity.position)
    if (distance > radius) continue
    if (!best || distance < best.distance) best = { entity, distance }
  }
  if (!best) return fail('NO_TARGET', `半径 ${radius} 格内没有可攻击目标。`)
  if (bot.entity.position.distanceTo(best.entity.position) > 3.5) {
    const nav = await import('./navigation.js')
    await nav.gotoPosition(botController, {
      x: Math.floor(best.entity.position.x),
      y: Math.floor(best.entity.position.y),
      z: Math.floor(best.entity.position.z),
      tolerance: 3,
      timeoutMs: 10_000
    }).catch(() => null)
  }
  bot.attack(best.entity)
  return { ok: true, target: best.entity.name, id: best.entity.id, health: bot.health }
}

/** Respawn after death. */
export async function respawnBot (botController) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  if (bot.health > 0) return { ok: true, skipped: true, message: '还活着，不需要重生。' }
  await bot.respawn().catch(() => {
    bot._client.write('client_command', { actionId: 0 })
  })
  return { ok: true, respawned: true }
}

/** Walk to nearby dropped items so the server hands them over. */
export async function collectItems (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const radius = Math.max(2, Math.min(32, Number(options.radius) || 8))
  const drops = Object.values(bot.entities ?? {})
    .filter((entity) => entity?.name === 'item' && entity.position)
    .map((entity) => ({ entity, distance: bot.entity.position.distanceTo(entity.position) }))
    .filter((entry) => entry.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
  if (drops.length === 0) return { ok: true, collected: 0, message: `半径 ${radius} 格内没有掉落物。` }
  const nav = await import('./navigation.js')
  let reached = 0
  for (const drop of drops.slice(0, Number(options.limit) || 6)) {
    const walked = await nav.gotoPosition(botController, {
      x: Math.floor(drop.entity.position.x),
      y: Math.floor(drop.entity.position.y),
      z: Math.floor(drop.entity.position.z),
      tolerance: 1.5,
      timeoutMs: 8_000
    }).catch(() => ({ ok: false }))
    if (walked.ok) reached += 1
  }
  return { ok: true, collected: reached, seen: drops.length }
}

/** Craft an item (2x2 in inventory, or at a nearby crafting table). */
export async function craftItem (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const name = String(options.item ?? '').replace(/^minecraft:/, '')
  if (!name) return fail('MC_INVENTORY_INVALID_ARGS', '需要 item（物品名）。')
  const crafts = Math.max(1, Math.min(64, Number(options.count) || 1))
  const item = bot.registry?.itemsByName?.[name]
  if (!item) return fail('ITEM_NOT_FOUND', `未知物品 ${name}。`)

  // Discovery: recipesAll() ignores whether we own the materials, so "no recipe"
  // and "no table" stay distinguishable from "not enough stuff".
  const pocketRecipes = bot.recipesAll(item.id, null, null)
  const tableRecipes = bot.recipesAll(item.id, null, true)
  if (pocketRecipes.length === 0 && tableRecipes.length === 0) {
    return fail('NO_RECIPE', `没有能合成 ${name} 的配方。`)
  }

  let tableBlock = null
  if (pocketRecipes.length === 0) {
    // Needs a 3x3 grid: find a bench, walk to it, and open it through craft().
    const positions = bot.findBlocks({ matching: (block) => block?.name === 'crafting_table', maxDistance: 8, count: 4 })
    for (const position of positions) {
      const block = bot.blockAt(position)
      if (!block) continue
      if (bot.entity.position.distanceTo(position) > 3.5) {
        const nav = await import('./navigation.js')
        await nav.gotoPosition(botController, {
          x: position.x,
          y: position.y,
          z: position.z,
          tolerance: 2.5,
          timeoutMs: 15_000
        }).catch(() => null)
      }
      tableBlock = bot.blockAt(position) ?? block
      break
    }
    if (!tableBlock) return fail('NO_TABLE', `合成 ${name} 需要工作台，但附近 8 格内没有。`)
  }

  const recipes = bot.recipesFor(item.id, null, crafts, tableBlock)
  if (recipes.length === 0) {
    return fail('MISSING_MATERIALS', `材料不足：合成 ${name} ×${crafts} 还缺东西。`, {
      inventory: inventorySummary(bot)
    })
  }

  // One craft per call: mineflayer's multi-craft loop can stop silently when the
  // window gets out of sync (creative inventories especially), and a partial
  // result would look like success. A lost result is retried once after closing
  // the window, because the server sometimes answers the first click late.
  let done = 0
  for (let i = 0; i < crafts; i++) {
    let crafted = false
    for (let attempt = 0; attempt < 2 && !crafted; attempt++) {
      const before = findItem(bot, name)?.count ?? 0
      try {
        await bot.craft(recipes[0], 1, tableBlock)
      } catch (error) {
        if (done === 0 && attempt === 1) return fail('CRAFT_FAILED', error instanceof Error ? error.message : String(error))
        try {
          if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
        } catch {
          /* ignore */
        }
        await sleep(800)
        continue
      }
      // Wait for the server to confirm the slot update.
      const deadline = Date.now() + 2_500
      while (Date.now() < deadline) {
        const now = findItem(bot, name)?.count ?? 0
        if (now > before) break
        await sleep(120)
      }
      const afterOne = findItem(bot, name)?.count ?? 0
      if (afterOne > before) {
        done += 1
        crafted = true
        // Close the crafting window and let the server finish the sync: chaining
        // crafts faster than this makes mineflayer click against a stale grid and
        // eat the ingredients (or lose the result).
        try {
          if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
        } catch {
          /* ignore */
        }
        await sleep(500)
      } else {
        // Nothing arrived: drop the window state and try this craft again.
        try {
          if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
        } catch {
          /* ignore */
        }
        await sleep(800)
      }
    }
    if (!crafted) break
  }

  const after = findItem(bot, name)
  if (!after || done === 0) {
    return fail('CRAFT_NOT_CONFIRMED', `合成 ${name} 没有出现在背包里（可能被服务器拒绝或背包已满）。`, {
      inventory: inventorySummary(bot)
    })
  }
  return { ok: true, crafted: name, count: after.count, crafts: done, viaTable: Boolean(tableBlock) }
}

/** Smelt in a nearby furnace. */
export async function smeltItem (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const inputName = String(options.input ?? '').replace(/^minecraft:/, '')
  const fuelName = String(options.fuel ?? 'coal').replace(/^minecraft:/, '')
  const input = findItem(bot, inputName)
  if (!input) return fail('ITEM_NOT_FOUND', `背包里没有 ${inputName}。`)
  const fuel = findItem(bot, fuelName)
  if (!fuel) return fail('ITEM_NOT_FOUND', `背包里没有燃料 ${fuelName}。`)

  const positions = bot.findBlocks({ matching: (block) => /^(furnace|blast_furnace|smoker)$/.test(block?.name ?? ''), maxDistance: 6, count: 4 })
  if (positions.length === 0) return fail('NO_FURNACE', '附近 6 格内没有熔炉。')
  const position = positions[0]
  const nav = await import('./navigation.js')
  if (bot.entity.position.distanceTo(position) > 3.5) {
    await nav.gotoPosition(botController, { x: position.x, y: position.y, z: position.z, tolerance: 2.5, timeoutMs: 15_000 }).catch(() => null)
  }
  const block = bot.blockAt(position)
  let furnace
  try {
    furnace = await bot.openFurnace(block)
  } catch (error) {
    return fail('FURNACE_OPEN_FAILED', error instanceof Error ? error.message : String(error))
  }
  try {
    await furnace.putInput(input.type, null, Math.min(input.count, Number(options.count) || 1))
    await furnace.putFuel(fuel.type, null, Math.min(fuel.count, Number(options.fuelCount) || 1))
    const deadline = Date.now() + Math.max(5_000, Math.min(60_000, Number(options.timeoutMs) || 25_000))
    let output = null
    while (Date.now() < deadline) {
      await sleep(500)
      output = furnace.outputItem()
      if (output) break
    }
    if (!output) return fail('SMELT_TIMEOUT', '等不到熔炼产物（燃料不足或熔炉被占用？）。')
    await furnace.takeOutput()
    return { ok: true, smelted: output.name, count: output.count }
  } finally {
    try {
      furnace.close()
    } catch {
      /* ignore */
    }
  }
}

/** Open a container: list / take / put. */
export async function containerAction (botController, options = {}) {
  const bot = botController?.bot
  if (!bot?.entity) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
  const action = String(options.action ?? 'list')
  const positions = [options.x, options.y, options.z].every((v) => Number.isFinite(Number(v)))
    ? [new Vec3(Math.floor(Number(options.x)), Math.floor(Number(options.y)), Math.floor(Number(options.z)))]
    : bot.findBlocks({ matching: (block) => /^(chest|trapped_chest|barrel)$/.test(block?.name ?? ''), maxDistance: 6, count: 4 })
  if (positions.length === 0) return fail('NO_CONTAINER', '附近 6 格内没有箱子/木桶。')
  const position = positions[0]
  const nav = await import('./navigation.js')
  if (bot.entity.position.distanceTo(position) > 3.5) {
    await nav.gotoPosition(botController, { x: position.x, y: position.y, z: position.z, tolerance: 2.5, timeoutMs: 15_000 }).catch(() => null)
  }
  const block = bot.blockAt(position)
  let container
  try {
    container = await bot.openContainer(block)
  } catch (error) {
    return fail('CONTAINER_OPEN_FAILED', error instanceof Error ? error.message : String(error))
  }
  try {
    const contents = container.containerItems().map((item) => ({ name: item.name, count: item.count }))
    if (action === 'list') return { ok: true, container: block.name, items: contents }
    const name = String(options.item ?? '').replace(/^minecraft:/, '')
    const item = bot.registry?.itemsByName?.[name]
    if (!item) return fail('ITEM_NOT_FOUND', `未知物品 ${name}。`)
    const count = Math.max(1, Math.min(2304, Number(options.count) || 1))
    if (action === 'take') {
      await container.withdraw(item.id, null, count)
      return { ok: true, took: name, count }
    }
    if (action === 'put') {
      await container.deposit(item.id, null, count)
      return { ok: true, put: name, count }
    }
    return fail('MC_INVENTORY_INVALID_ARGS', 'container 的 action 只能是 list / take / put。')
  } finally {
    try {
      container.close()
    } catch {
      /* ignore */
    }
  }
}






