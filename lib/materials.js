/**
 * Material acquisition for builds.
 *
 * Given the blocks a schematic needs, work out where each missing stack comes
 * from — chopping trees, mining stone and ores, crafting planks/sticks/tools,
 * smelting ingots, looting chests — and go get them with the existing
 * behaviours and action primitives.
 *
 * Creative mode is handled a different way: there is nothing to gather when the
 * build itself can fill blocks, so `acquire()` reports `mode: 'creative'` and
 * leaves the filling to the builder.
 */
import * as actions from './actions.js'

const LOG_RE = /_log$/
const PLANKS_RE = /_planks$/
const ORE_RE = /_ore$/
const INGOT_RE = /_ingot$/

const DIRT_LIKE = new Set(['dirt', 'grass_block', 'sand', 'gravel', 'clay', 'podzol', 'coarse_dirt', 'red_sand', 'snow_block', 'stone', 'cobblestone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'calcite'])

const STONE_LIKE = new Set(['cobblestone', 'stone_bricks', 'mossy_stone_bricks', 'stone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff'])

const CHEST_BLOCKS = ['chest', 'trapped_chest', 'barrel']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const countOf = (bot, name) => bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0)

/** What kind of source an item comes from. */
export function classify (name) {
  if (LOG_RE.test(name)) return { kind: 'log', block: name }
  if (PLANKS_RE.test(name)) return { kind: 'planks', source: name.replace('_planks', '_log') }
  if (name === 'stick') return { kind: 'stick' }
  if (name === 'crafting_table') return { kind: 'table' }
  if (name === 'furnace') return { kind: 'furnace' }
  if (ORE_RE.test(name)) return { kind: 'ore', block: name }
  if (INGOT_RE.test(name)) return { kind: 'ingot', ore: `${name.replace('_ingot', '')}_ore` }
  if (name === 'glass') return { kind: 'glass' }
  if (name === 'coal') return { kind: 'ore', block: 'coal_ore' }
  if (STONE_LIKE.has(name)) return { kind: 'stone', block: 'stone' }
  if (DIRT_LIKE.has(name)) return { kind: 'dig', block: name }
  return { kind: 'loot', block: name }
}

export class MaterialGatherer {
  constructor ({ botController, config, events, behaviors, world = null, actions: actionsApi = actions }) {
    this.botController = botController
    this.config = config
    this.events = events
    this.behaviors = behaviors
    this.world = world
    this.actions = actionsApi
    this.lastRun = null
  }

  get bot () {
    return this.botController?.bot ?? null
  }

  /** Missing amounts for a required map, ignoring what is already carried. */
  missingFrom (required) {
    const bot = this.bot
    const missing = {}
    for (const [name, need] of Object.entries(required ?? {})) {
      const have = countOf(bot, name)
      if (have < need) missing[name] = { need, have }
    }
    return missing
  }

  /** Dry run: say where each missing stack would come from. */
  plan (required) {
    const missing = this.missingFrom(required)
    const items = Object.entries(missing).map(([name, amounts]) => ({
      name,
      ...amounts,
      missing: amounts.need - amounts.have,
      ...classify(name)
    }))
    return { required: { ...required }, missing, items }
  }

  /**
   * Acquire everything the build needs.
   * @returns {Promise<{ok: boolean, mode: string, obtained: object, stillMissing: object, steps: any[]}>}
   */
  async acquire ({ required, allowCreativeFill = false, rounds = 3, timeoutMs = 600_000 } = {}) {
    const bot = this.bot
    if (!bot?.entity) throw new Error('GATHER_NOT_CONNECTED: Bot 尚未上线。')
    const creative = bot.game?.gameMode === 'creative' && allowCreativeFill === true
    if (creative) {
      this.lastRun = { mode: 'creative', obtained: {}, stillMissing: {}, steps: [] }
      return { ok: true, ...this.lastRun }
    }

    const startedAt = Date.now()
    const steps = []
    const obtained = {}
    const record = (step) => {
      steps.push({ ...step, at: Date.now() })
      this.events?.push?.('gather', `采集：${step.note}`, { item: step.item, amount: step.amount })
    }

    let missing = this.missingFrom(required)
    for (let round = 0; round < rounds && Object.keys(missing).length > 0; round++) {
      if (Date.now() - startedAt > timeoutMs) break
      const before = { ...missing }
      const items = Object.entries(missing).map(([name, amounts]) => ({ name, ...amounts, ...classify(name) }))

      // 1. wood first: planks/sticks/table all depend on logs.
      const logsNeeded = items
        .filter((item) => item.kind === 'log' || item.kind === 'planks' || item.kind === 'stick' || item.kind === 'table' || item.kind === 'furnace')
        .reduce((sum, item) => {
          if (item.kind === 'log') return sum + (item.need - item.have)
          if (item.kind === 'planks') return sum + Math.ceil((item.need - item.have) / 4)
          if (item.kind === 'stick') return sum + 1
          if (item.kind === 'table') return sum + 1
          return sum + 2
        }, 0)
      if (logsNeeded > countOf(bot, 'oak_log') + countOf(bot, 'birch_log') + countOf(bot, 'spruce_log') + countOf(bot, 'jungle_log') + countOf(bot, 'acacia_log') + countOf(bot, 'dark_oak_log')) {
        const want = Math.min(32, logsNeeded)
        await this.#behavior('woodcut', { amount: want })
        record({ item: 'logs', amount: want, note: `砍树 ${want} 个` })
        try {
          await this.actions.collectItems(this.botController, { radius: 12 })
        } catch {
          /* the next round verifies */
        }
      }

      // 2. crafting: planks -> sticks -> table -> furnace
      for (const item of items) {
        const lack = item.need - item.have
        if (lack <= 0) continue
        if (item.kind === 'planks' || item.kind === 'stick' || item.kind === 'table' || item.kind === 'furnace') {
          const result = await this.actions.craftItem(this.botController, { item: item.name, count: lack })
          if (result?.ok) record({ item: item.name, amount: lack, note: `合成 ${item.name} ×${lack}` })
          else record({ item: item.name, amount: 0, note: `合成 ${item.name} 失败：${result?.message ?? result?.error}` })
        }
      }

      // 3. stone and ores
      for (const item of items) {
        const lack = item.need - item.have
        if (lack <= 0) continue
        if (item.kind === 'stone' || item.kind === 'ore' || item.kind === 'ingot' || item.kind === 'glass') {
          const block = item.kind === 'ingot' ? item.ore : item.kind === 'glass' ? 'sand' : item.block
          const targetName = item.kind === 'stone' ? 'stone' : block
          const before = countOf(bot, item.kind === 'stone' ? 'cobblestone' : item.name)
          await this.#behavior('mine', { targets: [targetName], amount: Math.min(64, lack) })
          const after = countOf(bot, item.kind === 'stone' ? 'cobblestone' : item.name)
          record({ item: item.name, amount: Math.max(0, after - before), note: `挖 ${targetName} ${lack} 个` })
        }
      }

      // 4. smelting for ingots / glass
      for (const item of items) {
        const lack = item.need - item.have
        if (lack <= 0) continue
        if (item.kind === 'ingot' || item.kind === 'glass') {
          const input = item.kind === 'ingot' ? item.ore : 'sand'
          const result = await this.actions.smeltItem(this.botController, { input, fuel: 'coal', count: Math.min(16, lack) })
          if (result?.ok) record({ item: item.name, amount: result.count ?? lack, note: `烧炼 ${input} → ${item.name}` })
        }
      }

      // 5. anything left: try nearby chests
      const leftovers = items.filter((item) => countOf(bot, item.name) < item.need)
      if (leftovers.length > 0) {
        const looted = await this.#lootChests(leftovers.map((item) => item.name))
        for (const entry of looted) record(entry)
      }

      missing = this.missingFrom(required)
      if (JSON.stringify(missing) === JSON.stringify(before)) break
    }

    for (const [name, amounts] of Object.entries(this.missingFrom(required))) {
      obtained[name] = Math.max(0, (required[name] ?? 0) - (amounts.need - amounts.have))
    }
    const stillMissing = this.missingFrom(required)
    this.lastRun = {
      mode: 'survival',
      obtained,
      stillMissing,
      steps,
      elapsedMs: Date.now() - startedAt
    }
    return { ok: Object.keys(stillMissing).length === 0, ...this.lastRun }
  }

  /** Take matching items out of nearby chests. */
  async #lootChests (names) {
    const bot = this.bot
    const ids = CHEST_BLOCKS.map((name) => bot.registry?.blocksByName?.[name]?.id).filter((id) => id !== undefined)
    if (ids.length === 0) return []
    const found = bot.findBlocks({ matching: (block) => ids.includes(block?.type), maxDistance: 32, count: 8 })
    const out = []
    for (const position of found) {
      const block = bot.blockAt(position)
      if (!block) continue
      for (const name of names) {
        const have = countOf(bot, name)
        if (have > 0) continue
        const result = await this.actions.containerAction(this.botController, {
          action: 'take',
          item: name,
          count: 64,
          x: position.x,
          y: position.y,
          z: position.z
        })
        if (result?.ok) out.push({ item: name, amount: result.taken ?? 0, note: `从箱子取 ${name}` })
        await sleep(200)
      }
    }
    return out
  }

  /** Run a behaviour to completion, bounded. */
  async #behavior (mode, options) {
    if (!this.behaviors) return
    try {
      this.behaviors.start(mode, options)
    } catch (error) {
      this.events?.push?.('error', `采集行为启动失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      const snapshot = this.behaviors.snapshot()
      if (!snapshot.active) return
      await sleep(400)
    }
    this.behaviors.stop('gather timeout')
  }
}
