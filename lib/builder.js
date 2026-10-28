/**
 * Schematic reproduction on a live Mineflayer bot.
 *
 * Flow: preflight (dimensions, occupied cells, materials) -> ordered placement
 * -> progress events. Preflight is intentionally strict: a build with missing
 * materials is refused *before* a single block is placed, because the companion
 * must never go mining on its own. The caller decides whether to restock.
 *
 * Placement uses Mineflayer's own `placeBlock` against adjacent solid faces,
 * with pathfinder only for walking into reach. No digging, no combat, no
 * inventory crafting — unless the caller explicitly opts into clearing the
 * footprint (`onOccupied: 'clear'`).
 */

import minecraftData from 'minecraft-data'
import vec3Pkg from 'vec3'
import itemPkg from 'prismarine-item'

const { Vec3 } = vec3Pkg

const AIR = new Set(['air', 'cave_air', 'void_air'])
const FACE_OFFSETS = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0), name: 'below' },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1), name: 'north' },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1), name: 'south' },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0), name: 'west' },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0), name: 'east' },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0), name: 'above' },
]

function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Rotate a schematic coordinate by 0/90/180/270 degrees around the origin. */
export function rotatePosition(position, size, rotation) {
  const turns = ((Number(rotation) || 0) % 360 + 360) % 360
  switch (turns) {
    case 90:
      return new Vec3(size.z - 1 - position.z, position.y, position.x)
    case 180:
      return new Vec3(size.x - 1 - position.x, position.y, size.z - 1 - position.z)
    case 270:
      return new Vec3(position.z, position.y, size.x - 1 - position.x)
    default:
      return new Vec3(position.x, position.y, position.z)
  }
}

/** Material totals for a loaded prismarine-schematic. */
export async function countMaterials(schematic) {
  const counts = new Map()
  // prismarine-schematic's forEach awaits every callback; not awaiting it
  // would count only the first block.
  await schematic.forEach((block) => {
    if (!block || AIR.has(block.name)) return
    counts.set(block.name, (counts.get(block.name) ?? 0) + 1)
  })
  return counts
}

function inventoryCounts(bot) {
  const counts = new Map()
  for (const item of bot.inventory?.items?.() ?? []) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
  }
  return counts
}

/** Default temporary blocks used to climb out of pits / bridge gaps. */
export const DEFAULT_SCAFFOLD_BLOCKS = ['dirt', 'cobblestone', 'stone', 'oak_planks', 'oak_log', 'sand']

/**
 * Pick a temporary block for pathfinder's 1x1 tower/bridge moves. This is only
 * a *build* capability: the passive follow movements never enable towers.
 *
 * Preference order skips blocks the schematic itself needs, so a build does not
 * eat its own materials first.
 */
export function resolveScaffold({ bot, mcData, required, options = {} }) {
  if (options.allowScaffold === false) {
    return { enabled: false, reason: 'DISABLED', name: null, available: 0, budget: 0, creativeFill: false }
  }
  const budget = Math.max(1, Math.min(128, Number(options.scaffoldBudget) || 16))
  const candidates = Array.isArray(options.scaffoldBlocks) && options.scaffoldBlocks.length > 0
    ? options.scaffoldBlocks.map(String)
    : DEFAULT_SCAFFOLD_BLOCKS
  const needed = required instanceof Map ? required : new Map()
  const ordered = [
    ...candidates.filter((name) => !needed.has(name)),
    ...candidates.filter((name) => needed.has(name)),
  ]
  const inventory = inventoryCounts(bot)
  for (const name of ordered) {
    const count = inventory.get(name) ?? 0
    if (count > 0 && mcData.itemsByName[name]) {
      return {
        enabled: true,
        name,
        itemId: mcData.itemsByName[name].id,
        available: count,
        budget,
        creativeFill: false,
        reason: null,
      }
    }
  }
  const creative = bot.game?.gameMode === 'creative' && options.allowCreativeFill === true
  if (creative) {
    const name = ordered.find((candidate) => mcData.itemsByName[candidate]) ?? 'dirt'
    return {
      enabled: true,
      name,
      itemId: mcData.itemsByName[name]?.id,
      available: 0,
      budget,
      creativeFill: true,
      reason: 'CREATIVE_FILL',
    }
  }
  return {
    enabled: false,
    reason: 'NO_SCAFFOLD_MATERIAL',
    name: null,
    available: 0,
    budget,
    creativeFill: false,
    candidates,
  }
}

/**
 * Resolve the origin for a build. `position` wins; otherwise the spot in front
 * of the player at build time.
 */
export function resolveOrigin(bot, position, { rotation = 0, size, distance = 4 } = {}) {
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z)) {
    return new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z))
  }
  if (!bot?.entity) throw new Error('BUILD_NO_ORIGIN: 没有 position，且 Bot 不在线，无法选择玩家前方。')
  const base = bot.entity.position.floored()
  const yaw = bot.entity.yaw ?? 0
  // Minecraft yaw: 0 faces south (+z), 90° faces west (-x).
  const dx = -Math.sin(yaw) * distance
  const dz = Math.cos(yaw) * distance
  const origin = new Vec3(Math.floor(base.x + dx), Math.floor(base.y), Math.floor(base.z + dz))
  void rotation
  void size
  return origin
}

/**
 * Read-only preflight for a build.
 * @returns {Promise<Record<string, any>>}
 */
export async function planBuild({ bot, schematic, origin, options = {} }) {
  if (!bot?.entity) throw new Error('BUILD_NOT_CONNECTED: Bot 尚未上线。')
  const version = bot.version
  const mcData = minecraftData(version)

  if (typeof bot.waitForChunksToLoad === 'function') {
    await withTimeout(bot.waitForChunksToLoad(), 15_000, 'BUILD_CHUNKS_TIMEOUT: 等待区块加载超时').catch(() => {})
  }

  const rotation = Number(options.rotation) || 0
  const size = schematic.size
  const required = await countMaterials(schematic)
  const scaffold = resolveScaffold({ bot, mcData, required, options })
  const targets = []
  const occupied = []
  const alreadyCorrect = []
  let totalSolid = 0

  await schematic.forEach((block, pos) => {
    if (!block || AIR.has(block.name)) return
    totalSolid += 1
    const local = rotatePosition(pos, size, rotation)
    const world = origin.plus(local)
    const existing = bot.blockAt(world)
    if (existing?.name === block.name) {
      alreadyCorrect.push({ pos: world, name: block.name })
      return
    }
    if (existing && !AIR.has(existing.name)) {
      occupied.push({ pos: world, name: block.name, existing: existing.name })
    }
    targets.push({
      pos: world,
      name: block.name,
      local: { x: pos.x, y: pos.y, z: pos.z },
    })
  })

  const inventory = inventoryCounts(bot)
  const creative = bot.game?.gameMode === 'creative' && options.allowCreativeFill === true
  const missing = {}
  for (const [name, need] of required) {
    const have = inventory.get(name) ?? 0
    if (have < need && !creative) missing[name] = { need, have }
  }

  // An origin in mid-air can never bootstrap: every block would fail
  // NO_SUPPORT. Report that before placing anything, with a fixable hint.
  const hasAnySolidNeighbour = (position) => {
    for (const { offset } of FACE_OFFSETS) {
      const neighbour = bot.blockAt(position.plus(offset))
      if (neighbour && !AIR.has(neighbour.name) && neighbour.boundingBox !== 'empty') return true
    }
    return false
  }
  if (targets.length > 0 && !targets.some((target) => hasAnySolidNeighbour(target.pos))) {
    return {
      ok: false,
      error: 'BUILD_UNSUPPORTED_ORIGIN',
      message:
        '建造原点悬空：所有目标方块都不挨着任何实体方块，无法放下第一块。请把 position 设在地面或已有结构上（可以用 mc_status 查看玩家位置）。',
      origin,
      size,
      targetCount: targets.length,
      hint: '在平地/地面上建造时，origin.y 通常等于玩家脚部 Y。',
    }
  }

  if (options.maxBuildBlocks && targets.length > options.maxBuildBlocks) {
    throw new Error(`BUILD_TOO_LARGE: 本次要放置 ${targets.length} 个方块，超过上限 ${options.maxBuildBlocks}`)
  }

  const onOccupied = options.onOccupied === 'skip' || options.onOccupied === 'clear' ? options.onOccupied : 'abort'
  if (occupied.length > 0 && onOccupied === 'abort') {
    return {
      ok: false,
      error: 'BUILD_AREA_OCCUPIED',
      message: `目标区域有 ${occupied.length} 个位置已被非目标方块占据；传 onOccupied:"skip" 跳过，或 "clear" 清除（会挖方块）。`,
      occupied: occupied.slice(0, 20),
      occupiedCount: occupied.length,
      origin,
      size,
      scaffold,
    }
  }

  // `skip` means the occupied cells are not part of this build at all; the
  // caller accepted holes where existing blocks stay.
  let buildTargets = targets
  if (occupied.length > 0 && onOccupied === 'skip') {
    const blocked = new Set(occupied.map((entry) => `${entry.pos.x},${entry.pos.y},${entry.pos.z}`))
    buildTargets = targets.filter((entry) => !blocked.has(`${entry.pos.x},${entry.pos.y},${entry.pos.z}`))
  }

  if (Object.keys(missing).length > 0) {
    return {
      ok: false,
      error: 'MISSING_MATERIALS',
      message: `缺少 ${Object.keys(missing).length} 种材料。陪伴 Bot 不会自动挖矿，请先补料或改用创造模式测试。`,
      missing,
      required: Object.fromEntries(required),
      inventory: Object.fromEntries(inventory),
      origin,
      size,
      scaffold,
    }
  }

  return {
    ok: true,
    version,
    origin,
    size: { x: size.x, y: size.y, z: size.z },
    rotation,
    totalSolid,
    targetCount: buildTargets.length,
    alreadyCorrect: alreadyCorrect.length,
    occupied: occupied.slice(0, 20),
    occupiedCount: occupied.length,
    onOccupied,
    required: Object.fromEntries(required),
    inventory: Object.fromEntries(inventory),
    creativeFill: creative,
    scaffold,
    estimatedSeconds: Math.ceil(buildTargets.length / Math.max(1, options.buildSpeed ?? 6)),
    targets: buildTargets,
  }
}

export class BuildTask {
  /**
   * @param {{ bot: any, schematic: any, origin: any, options: Record<string, any>, events: any }} input
   */
  constructor({ bot, schematic, origin, options, events }) {
    this.bot = bot
    this.schematic = schematic
    this.origin = origin
    this.options = options
    this.events = events
    this.id = `build-${Date.now().toString(36)}`
    this.name = options.name ?? 'schematic'
    this.status = 'running'
    this.cancelled = false
    this.startedAt = Date.now()
    this.finishedAt = 0
    this.placed = 0
    this.skipped = 0
    this.failed = 0
    this.total = 0
    this.errors = []
    this.lastProgressAt = 0
    this.failure = null
    this.scaffold = null
    this.scaffoldActive = false
    this.scaffoldUsed = 0
    this.scaffoldStartCount = 0
    this.scaffoldPlacements = 0
    /** @type {((block: any, face: any) => Promise<void>) | null} */
    this.originalPlaceBlock = null
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      origin: { x: this.origin.x, y: this.origin.y, z: this.origin.z },
      total: this.total,
      placed: this.placed,
      skipped: this.skipped,
      failed: this.failed,
      remaining: Math.max(0, this.total - this.placed - this.skipped - this.failed),
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      elapsedMs: (this.finishedAt || Date.now()) - this.startedAt,
      errors: this.errors.slice(0, 10),
      failure: this.failure,
      scaffold: this.scaffold
        ? {
            enabled: this.scaffold.enabled,
            name: this.scaffold.name,
            reason: this.scaffold.reason,
            active: this.scaffoldActive,
            used: this.scaffoldUsed,
            placements: this.scaffoldPlacements,
          }
        : null,
    }
  }

  cancel(reason = 'user') {
    if (this.status !== 'running') return false
    this.cancelled = true
    this.reason = reason
    try {
      this.bot?.pathfinder?.stop?.()
    } catch {
      /* ignore */
    }
    return true
  }

  #noteError(pos, name, error) {
    this.failed += 1
    if (this.errors.length < 20) {
      this.errors.push({ pos: { x: pos.x, y: pos.y, z: pos.z }, name, error: String(error?.message ?? error) })
    }
  }

  #progress(force = false) {
    const now = Date.now()
    if (!force && now - this.lastProgressAt < 1_000) return
    this.lastProgressAt = now
    this.events.push('build_progress', `建造 ${this.placed}/${this.total}（跳过 ${this.skipped}，失败 ${this.failed}）`, this.snapshot())
  }

  #scaffoldCount() {
    if (!this.scaffold?.name) return 0
    let count = 0
    for (const item of this.bot.inventory?.items?.() ?? []) {
      if (item.name === this.scaffold.name) count += item.count
    }
    return count
  }

  /** Creative test mode: put a temporary scaffold stack into the inventory. */
  async #fillScaffold(mcData, Item) {
    if (!this.scaffold?.enabled || !this.scaffold.creativeFill) return
    if (this.#scaffoldCount() > 0) return
    const itemData = mcData.itemsByName[this.scaffold.name]
    if (!itemData) return
    try {
      const slot = this.bot.inventory.firstEmptyInventorySlot() ?? 36
      await this.bot.creative.setInventorySlot(slot, new Item(itemData.id, this.scaffold.budget))
      await wait(120)
    } catch (error) {
      this.events.push('build_scaffold', `创造模式填充垫脚方块失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Turn on pathfinder's 1x1 tower/bridge moves for this build. The pathfinder
   * equips a scaffolding block, jumps and places it under itself (the classic
   * "jump + place under feet"), and can bridge short gaps. Only called after a
   * normal path failed, so ordinary builds do not scatter scaffold blocks.
   */
  async #enableScaffold() {
    if (this.scaffoldActive) return true
    if (!this.scaffold?.enabled || !this.scaffold.itemId) return false
    if (this.#scaffoldCount() <= 0) {
      this.events.push('build_scaffold', `没有 ${this.scaffold.name}，无法垫脚`)
      return false
    }
    try {
      const pathfinderModule = await import('mineflayer-pathfinder')
      const { Movements } = pathfinderModule.default ?? pathfinderModule
      const movements = new Movements(this.bot)
      movements.canDig = false
      movements.allow1by1towers = true
      movements.scafoldingBlocks = [this.scaffold.itemId]
      movements.maxDropDown = 3
      movements.canOpenDoors = false
      this.bot.pathfinder.setMovements(movements)
      this.scaffoldActive = true
      this.scaffoldPlacements = 0
      // Creative mode does not consume the item, so inventory deltas are not
      // enough to report usage. Count the placements the pathfinder makes
      // while holding the scaffold block.
      const scaffoldName = this.scaffold.name
      this.originalPlaceBlock = this.bot.placeBlock.bind(this.bot)
      const originalPlaceBlock = this.originalPlaceBlock
      this.bot.placeBlock = async (block, face) => {
        const held = this.bot.heldItem?.name
        try {
          return await originalPlaceBlock(block, face)
        } finally {
          if (held === scaffoldName) this.scaffoldPlacements += 1
        }
      }
      this.events.push(
        'build_scaffold',
        `寻路受阻：启用垫脚/搭路（使用 ${this.scaffold.name}，预算 ${this.scaffold.budget}）`,
        { name: this.scaffold.name, at: this.positionJson() },
      )
      return true
    } catch (error) {
      this.events.push('build_scaffold', `启用垫脚失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Restore the passive, no-placement movements used by following. */
  async #restoreMovements() {
    if (!this.scaffoldActive) return
    try {
      const pathfinderModule = await import('mineflayer-pathfinder')
      const { Movements } = pathfinderModule.default ?? pathfinderModule
      const movements = new Movements(this.bot)
      movements.canDig = false
      movements.allow1by1towers = false
      movements.scafoldingBlocks = []
      movements.maxDropDown = 3
      movements.canOpenDoors = false
      this.bot.pathfinder.setMovements(movements)
    } catch {
      /* pathfinder may already be gone */
    }
    const remaining = this.#scaffoldCount()
    const consumed = Math.max(0, this.scaffoldStartCount - remaining)
    this.scaffoldUsed = Math.max(consumed, this.scaffoldPlacements)
    if (this.originalPlaceBlock) {
      try {
        this.bot.placeBlock = this.originalPlaceBlock
      } catch {
        /* ignore */
      }
      this.originalPlaceBlock = null
    }
    this.scaffoldActive = false
    this.events.push(
      'build_scaffold',
      `垫脚结束：放置 ${this.scaffoldPlacements} 次 ${this.scaffold.name}（库存消耗 ${consumed}）`,
      { used: this.scaffoldUsed, placements: this.scaffoldPlacements, remaining },
    )
  }

  positionJson() {
    const position = this.bot?.entity?.position
    return position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null
  }

  async start(plan) {
    const { bot, options } = this
    const mcData = minecraftData(bot.version)
    const Item = itemPkg(bot.version)
    const reach = Math.min(4.5, Math.max(2, Number(options.reach) || 4.2))
    const delay = 1000 / Math.max(1, Number(options.buildSpeed) || 6)
    const creativeFill = options.allowCreativeFill === true && bot.game?.gameMode === 'creative'

    // Scaffolding is a build-only capability. The passive follow movements
    // never enable towers; this task may, and restores them when it ends.
    this.scaffold = plan.scaffold ?? null
    if (this.scaffold?.enabled && !this.scaffold.itemId) {
      this.scaffold = { ...this.scaffold, enabled: false, reason: 'NO_SCAFFOLD_ITEM' }
    }
    if (this.scaffold?.enabled && this.scaffold.creativeFill) {
      await this.#fillScaffold(mcData, Item)
    }
    this.scaffoldStartCount = this.scaffold?.enabled ? this.#scaffoldCount() : 0

    this.total = plan.targetCount
    this.events.push('build_start', `开始建造 ${this.name}：${this.total} 个方块，原点 ${this.origin.x},${this.origin.y},${this.origin.z}`, {
      task: this.snapshot(),
      required: plan.required,
      scaffold: this.scaffold,
    })
    this.#progress(true)

    /** @type {Array<{pos: any, name: string, attempts: number, lastError: string | null}>} */
    const pending = plan.targets.map((target) => ({ ...target, attempts: 0, lastError: null }))
    const MAX_ATTEMPTS = 3
    let pass = 0

    // Clear occupied cells only when the caller explicitly asked for it.
    if (plan.onOccupied === 'clear' && plan.occupiedCount > 0) {
      for (const entry of plan.occupied) {
        if (this.cancelled) break
        const block = bot.blockAt(entry.pos)
        if (!block || AIR.has(block.name)) continue
        try {
          await this.#walkNear(entry.pos, reach)
          await withTimeout(bot.dig(block), 10_000, 'BUILD_DIG_TIMEOUT')
        } catch (error) {
          this.#noteError(entry.pos, entry.existing, error)
        }
      }
    }

    // Pass-based placement: a roof cell may have no support on its first try
    // but gain one a few blocks later, so failures are retried instead of
    // being dropped on the first pass.
    try {
      while (pending.length > 0 && !this.cancelled) {
        pass += 1
        let resolved = 0
        const botPos = bot.entity?.position ?? this.origin
        const ordered = pending
          .slice()
          .sort((a, b) => a.pos.y - b.pos.y || a.pos.distanceSquared(botPos) - b.pos.distanceSquared(botPos))

        for (const target of ordered) {
          if (this.cancelled) break
          // Always re-read: an earlier placement in this pass may already have
          // put the right block here.
          const existing = bot.blockAt(target.pos)
          if (existing?.name === target.name) {
            this.skipped += 1
            pending.splice(pending.indexOf(target), 1)
            this.#progress()
            continue
          }
          try {
            const placed = await this.#placeOne(target, { reach, delay, mcData, Item, creativeFill })
            if (placed) {
              this.placed += 1
              resolved += 1
              pending.splice(pending.indexOf(target), 1)
            } else if (this.cancelled) {
              break
            } else {
              target.attempts += 1
              target.lastError = 'SKIPPED: 无法在可达范围内放置（需要脚手架或更近的位置）'
              if (target.attempts >= MAX_ATTEMPTS) {
                this.#noteError(target.pos, target.name, new Error(target.lastError))
                pending.splice(pending.indexOf(target), 1)
                resolved += 1
              }
            }
          } catch (error) {
            target.attempts += 1
            target.lastError = error instanceof Error ? error.message : String(error)
            if (target.attempts >= MAX_ATTEMPTS) {
              this.#noteError(target.pos, target.name, error)
              pending.splice(pending.indexOf(target), 1)
              resolved += 1
            }
          }
          this.#progress()
          if (this.status !== 'running') break
        }

        if (this.cancelled) break
        if (resolved === 0 || pass > 12) {
          // No block resolved in a whole pass: the remaining ones are genuinely
          // unreachable with this geometry (usually roof interiors).
          for (const target of pending.slice()) {
            this.#noteError(target.pos, target.name, new Error(target.lastError ?? 'UNREACHABLE: 连续多轮无法放置'))
          }
          pending.length = 0
        }
      }
    } finally {
      // Whether we finished, failed or got cancelled, following must never
      // inherit tower-building movements.
      await this.#restoreMovements()
    }

    if (this.cancelled) {
      // Count the blocks we never attempted as skipped, not failed.
      this.skipped += pending.length
    }

    this.finishedAt = Date.now()
    if (this.cancelled) {
      this.status = 'cancelled'
      this.events.push('build_cancelled', `建造已取消：已放 ${this.placed}/${this.total}`, this.snapshot())
    } else if (this.failed > 0 && this.placed === 0) {
      this.status = 'failed'
      this.failure = this.errors[0]?.error ?? '所有方块都放置失败'
      this.events.push('build_failed', `建造失败：${this.failure}`, this.snapshot())
    } else {
      this.status = 'done'
      this.events.push(
        'build_done',
        `建造结束：放置 ${this.placed}，跳过 ${this.skipped}，失败 ${this.failed}${this.failed ? '（见 errors）' : ''}`,
        this.snapshot(),
      )
    }
    return this.snapshot()
  }

  async #walkNear(pos, reach) {
    const bot = this.bot
    if (!bot?.entity) return
    if (bot.entity.position.distanceTo(pos) <= reach - 0.6) return
    if (!bot.pathfinder) throw new Error('BUILD_NO_PATHFINDER: 无法走近目标（pathfinder 未加载）')
    const pathfinderModule = await import('mineflayer-pathfinder')
    const { goals } = pathfinderModule.default ?? pathfinderModule
    // A roof cell above the bot has no walkable position at its own Y: aim for
    // the same X/Z on the floor instead, then place upward from inside.
    const makeGoal = () => {
      const feetY = bot.entity?.position?.floored?.().y ?? pos.y
      return pos.y > feetY + 0.5
        ? new goals.GoalNearXZ(pos.x, pos.z, 2)
        : new goals.GoalNear(pos.x, pos.y, pos.z, 2)
    }
    try {
      await withTimeout(bot.pathfinder.goto(makeGoal()), 12_000, 'BUILD_PATH_TIMEOUT: 走不到目标附近')
    } catch (error) {
      // Stuck in a pit or behind a wall: allow the pathfinder to jump-place
      // blocks under itself / bridge forward, then retry once.
      try {
        bot.pathfinder?.stop?.()
      } catch {
        /* ignore */
      }
      if (!this.scaffold?.enabled || this.cancelled) throw error
      const enabled = await this.#enableScaffold()
      if (!enabled) throw error
      await withTimeout(bot.pathfinder.goto(makeGoal()), 25_000, 'BUILD_PATH_TIMEOUT: 启用垫脚后仍走不到目标附近')
    }
  }

  async #equipFor(name, { Item, mcData, creativeFill }) {
    const bot = this.bot
    const item = bot.inventory.items().find((candidate) => candidate.name === name)
    if (item) {
      await withTimeout(bot.equip(item, 'hand'), 5_000, 'BUILD_EQUIP_TIMEOUT')
      return item
    }
    if (!creativeFill) {
      throw new Error(`MISSING_MATERIAL: 背包里没有 ${name}`)
    }
    const itemData = mcData.itemsByName[name]
    if (!itemData) throw new Error(`BUILD_NO_ITEM: 方块 ${name} 没有对应物品，无法放置`)
    const slot = bot.inventory.firstEmptyInventorySlot() ?? 36
    await bot.creative.setInventorySlot(slot, new Item(itemData.id, 64))
    await wait(80)
    const gained = bot.inventory.items().find((candidate) => candidate.name === name)
    if (!gained) throw new Error(`BUILD_CREATIVE_FILL_FAILED: 创造模式填充 ${name} 失败`)
    await withTimeout(bot.equip(gained, 'hand'), 5_000, 'BUILD_EQUIP_TIMEOUT')
    return gained
  }

  /**
   * The server refuses a placement inside the player's own bounding box, which
   * happens whenever the bot walks onto a floor cell it is about to fill.
   * Step back a few times; the caller retries the block later if this fails.
   */
  async #ensureFree(targetPos) {
    const bot = this.bot
    if (!bot?.entity) return
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const feet = bot.entity.position.floored()
      const head = feet.offset(0, 1, 0)
      if (!feet.equals(targetPos) && !head.equals(targetPos)) return
      try {
        bot.setControlState('back', true)
        await wait(260)
        bot.setControlState('back', false)
        await wait(120)
      } catch {
        break
      }
    }
    const feet = bot.entity.position.floored()
    if (feet.equals(targetPos) || feet.offset(0, 1, 0).equals(targetPos)) {
      throw new Error('SELF_OCCUPIED: Bot 正站在目标位置，稍后重试')
    }
  }

  async #placeOne(target, context) {
    const bot = this.bot
    await this.#walkNear(target.pos, context.reach)
    if (this.cancelled) return false
    await this.#ensureFree(target.pos)
    if (this.cancelled) return false

    // Find an adjacent solid face to place against, preferring the block below.
    const candidates = []
    for (const { offset, face } of FACE_OFFSETS) {
      const refPos = target.pos.plus(offset)
      const ref = bot.blockAt(refPos)
      if (!ref || AIR.has(ref.name) || ref.boundingBox === 'empty') continue
      candidates.push({ ref, face, refPos })
    }
    if (candidates.length === 0) {
      throw new Error('NO_SUPPORT: 目标方块没有任何相邻可依附面（悬空或区块未加载）')
    }

    await this.#equipFor(target.name, context)
    if (this.cancelled) return false

    let lastError = null
    for (const candidate of candidates) {
      try {
        // Look at the centre of the face we are placing against, not the block
        // centre: the server validates the ray/face pair.
        const faceCentre = candidate.ref.position.offset(0.5, 0.5, 0.5).plus(candidate.face.scaled(0.5))
        await withTimeout(bot.lookAt(faceCentre), 3_000, 'BUILD_LOOK_TIMEOUT')
        await withTimeout(bot.placeBlock(candidate.ref, candidate.face), 6_000, 'BUILD_PLACE_TIMEOUT')
        await wait(90)
        const after = bot.blockAt(target.pos)
        if (after?.name === target.name) {
          await wait(context.delay)
          return true
        }
        lastError = new Error(`VERIFY_FAILED: 放置后该位置是 ${after?.name ?? 'unknown'}，期望 ${target.name}`)
      } catch (error) {
        lastError = error
        // ViaBackwards / high-latency servers can deliver the block update
        // after Mineflayer's own "still air" check. Re-check once before
        // treating the placement as failed.
        if (/still air|refused to place/i.test(error instanceof Error ? error.message : String(error))) {
          await wait(300)
          const late = bot.blockAt(target.pos)
          if (late?.name === target.name) {
            await wait(context.delay)
            return true
          }
        }
      }
      if (this.cancelled) return false
    }
    throw lastError ?? new Error('PLACE_FAILED: 无法放置')
  }
}
