/**
 * World knowledge.
 *
 * Everything here answers "what is around me right now" without leaving the
 * loaded world: a block census, the biome/time/light context, ore counts, the
 * nearest structures detected through their marker blocks, and a small set of
 * remembered waypoints that survives a restart through the memory file.
 *
 * Structure detection is honest about its limits: it can only find what is in
 * the chunks the bot has loaded. `hunt()` therefore walks a little towards the
 * best guess and re-scans, and the tool reports the search radius it actually
 * covered.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const ORE_BLOCKS = [
  'coal_ore',
  'deepslate_coal_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'copper_ore',
  'gold_ore',
  'deepslate_gold_ore',
  'redstone_ore',
  'lapis_ore',
  'diamond_ore',
  'deepslate_diamond_ore',
  'emerald_ore',
  'nether_quartz_ore',
  'nether_gold_ore',
  'ancient_debris'
]

/** Marker blocks per structure; the first one found wins. */
export const STRUCTURE_MARKERS = Object.freeze({
  village: ['bell', 'composter', 'cartography_table', 'fletching_table', 'smithing_table'],
  dungeon: ['spawner', 'mossy_cobblestone'],
  ruined_portal: ['crying_obsidian', 'netherrack'],
  stronghold: ['end_portal_frame', 'chiseled_stone_bricks'],
  mineshaft: ['rail', 'cobweb'],
  fortress: ['nether_bricks', 'blaze_spawner'],
  bastion: ['polished_blackstone_bricks', 'magma_block']
})

export const STRUCTURE_KINDS = Object.keys(STRUCTURE_MARKERS)

const CENSUS_BLOCKS = [
  ...ORE_BLOCKS,
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'water',
  'lava',
  'grass_block',
  'sand',
  'gravel',
  'crafting_table',
  'furnace',
  'chest',
  'bed',
  'torch',
  'ladder'
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round1 = (value) => Math.round(value * 10) / 10

export class WorldModel {
  /**
   * @param {{ botController: any, config: Record<string, any>, events: any }} options
   */
  constructor ({ botController, config, events, memoryFile }) {
    this.botController = botController
    this.config = config
    this.events = events
    this.memoryFile = memoryFile ?? null
    this.waypoints = {}
    this.structureHits = {}
    this.lastScan = null
    this.loaded = false
  }

  get bot () {
    return this.botController?.bot ?? null
  }

  #requireBot () {
    const bot = this.bot
    if (!bot?.entity) throw new Error('MC_BOT_NOT_OFFLINE: Bot 不在线，先连接。')
    return bot
  }

  get timeOfDay () {
    const bot = this.bot
    if (!bot || typeof bot.time?.timeOfDay !== 'number') return null
    const ticks = bot.time.timeOfDay
    const hours = ((ticks + 6_000) % 24_000) / 1_000
    const hh = Math.floor(hours)
    const mm = Math.floor((hours - hh) * 60)
    return {
      ticks,
      clock: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      isDay: ticks < 12_000,
      // 0 = dawn, 0.5 = noon, 1 = dusk
      phase: round1(ticks / 24_000)
    }
  }

  get biome () {
    const bot = this.bot
    const position = bot?.entity?.position
    if (!position) return null
    try {
      const block = bot.blockAt(position)
      return block?.biome?.name ?? bot.world?.getColumn?.(position)?.biome?.name ?? null
    } catch {
      return null
    }
  }

  /** Nearest hostile entity summary (never players). */
  hostiles (radius = 16) {
    const bot = this.bot
    if (!bot?.entity) return []
    const rows = []
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity || entity === bot.entity || !entity.name) continue
      if (entity.type === 'player') continue
      const categories = bot.registry?.entitiesByName?.[entity.name]
      const isHostile = Boolean(entity.kind === 'Hostile mobs' || categories?.category === 'Hostile mobs' || /zombie|skeleton|creeper|spider|witch|enderman|blaze|piglin|hoglin|phantom|drowned|pillager|vindicator|ravager|silverfish|slime|magma|ghast|shulker|warden/i.test(entity.name))
      if (!isHostile) continue
      const distance = bot.entity.position.distanceTo(entity.position)
      if (distance > radius) continue
      rows.push({ name: entity.name, distance: round1(distance), position: { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z) } })
    }
    return rows.sort((a, b) => a.distance - b.distance)
  }

  /** Count the interesting blocks around the bot. */
  census ({ radius = 32 } = {}) {
    const bot = this.#requireBot()
    const r = Math.max(4, Math.min(64, Number(radius) || 32))
    const blocks = {}
    for (const name of CENSUS_BLOCKS) {
      const found = bot.findBlocks({ matching: (block) => block?.name === name, maxDistance: r, count: 256 })
      if (found.length > 0) blocks[name] = found.length
    }
    const ores = Object.fromEntries(Object.entries(blocks).filter(([name]) => ORE_BLOCKS.includes(name)))
    const logs = Object.fromEntries(Object.entries(blocks).filter(([name]) => /_log$/.test(name)))
    const census = {
      radius: r,
      blocks,
      ores,
      logs,
      oreCount: Object.values(ores).reduce((sum, count) => sum + count, 0),
      treeCount: Object.values(logs).reduce((sum, count) => sum + count, 0),
      water: blocks.water ?? 0,
      lava: blocks.lava ?? 0
    }
    this.lastScan = { at: Date.now(), ...census }
    return census
  }

  /**
   * Find the nearest structure of a kind among the loaded chunks.
   * @returns {{kind: string, marker: string, position: {x:number,y:number,z:number}, distance: number} | null}
   */
  findStructure (kind, { radius = 64 } = {}) {
    const bot = this.#requireBot()
    const markers = STRUCTURE_MARKERS[kind]
    if (!markers) throw new Error(`WORLD_UNKNOWN_STRUCTURE: 未知结构 ${kind}（可用：${STRUCTURE_KINDS.join(', ')}）`)
    const r = Math.max(8, Math.min(192, Number(radius) || 64))
    let best = null
    for (const marker of markers) {
      const found = bot.findBlocks({ matching: (block) => block?.name === marker, maxDistance: r, count: 8 })
      for (const position of found) {
        const distance = bot.entity.position.distanceTo({ x: position.x, y: position.y, z: position.z })
        if (!best || distance < best.distance) {
          best = { kind, marker, position: { x: position.x, y: position.y, z: position.z }, distance: round1(distance), radius: r }
        }
      }
    }
    if (best) this.structureHits[kind] = { ...best, at: Date.now() }
    return best
  }

  /** Scan every structure kind and return what was found. */
  survey (options = {}) {
    const radius = Math.max(8, Math.min(192, Number(options.radius) || 64))
    const found = {}
    for (const kind of STRUCTURE_KINDS) {
      const hit = this.findStructure(kind, { radius })
      if (hit) found[kind] = hit
    }
    return { radius, found, scannedAt: Date.now() }
  }

  /**
   * Walk a little towards a structure guess and scan again, because structures
   * outside the loaded chunks are invisible by definition.
   */
  async hunt (kind, { radius = 64, steps = 2, stepDistance = 24 } = {}) {
    const bot = this.#requireBot()
    let hit = this.findStructure(kind, { radius })
    let walked = 0
    for (let i = 0; i < steps && !hit; i++) {
      const angle = (i / Math.max(1, steps)) * Math.PI * 2
      const target = {
        x: Math.round(bot.entity.position.x + Math.cos(angle) * stepDistance),
        y: Math.round(bot.entity.position.y),
        z: Math.round(bot.entity.position.z + Math.sin(angle) * stepDistance)
      }
      const nav = await import('./navigation.js')
      const result = await nav.gotoPosition(this.botController, { ...target, tolerance: 3, timeoutMs: 30_000, force: true })
      walked += result.ok ? stepDistance : 0
      await sleep(600)
      hit = this.findStructure(kind, { radius })
    }
    return { hit, walked, radius }
  }

  async remember (name, position) {
    const bot = this.#requireBot()
    const place = position ?? bot.entity.position
    this.waypoints[name] = {
      x: Math.floor(place.x),
      y: Math.floor(place.y),
      z: Math.floor(place.z),
      at: new Date().toISOString()
    }
    await this.#save()
    return this.waypoints[name]
  }

  recall (name) {
    if (name) return this.waypoints[name] ?? null
    return this.waypoints
  }

  async load () {
    if (this.loaded || !this.memoryFile) return
    this.loaded = true
    try {
      const raw = await readFile(this.memoryFile, 'utf8')
      const parsed = JSON.parse(raw)
      this.waypoints = parsed.waypoints ?? {}
    } catch {
      this.waypoints = {}
    }
  }

  async #save () {
    if (!this.memoryFile) return
    try {
      await mkdir(path.dirname(this.memoryFile), { recursive: true })
      await writeFile(this.memoryFile, JSON.stringify({ waypoints: this.waypoints }, null, 2))
    } catch (error) {
      this.events?.push?.('error', `世界记忆保存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  snapshot () {
    const bot = this.bot
    if (!bot?.entity) {
      return { online: false, biome: null, time: null, dimension: null, hostiles: [], structures: this.structureHits, waypoints: this.waypoints, census: this.lastScan }
    }
    return {
      online: true,
      biome: this.biome,
      time: this.timeOfDay,
      dimension: bot.game?.dimension ?? null,
      position: { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) },
      hostiles: this.hostiles(16),
      structures: this.structureHits,
      waypoints: this.waypoints,
      census: this.lastScan
    }
  }
}
