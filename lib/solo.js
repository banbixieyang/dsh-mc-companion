/**
 * Solo play: a small, deterministic mission runner on top of the existing
 * behaviours + action primitives.
 *
 * Two plans:
 *  - `bootstrap` — start from an empty inventory and get to iron tools, the way
 *    a player opens a world (logs → planks → table → wooden pickaxe → stone →
 *    stone pickaxe → furnace → food).
 *  - `speedrun`  — the same opening, but every checkpoint is timed and reported,
 *    so "beat it faster" becomes measurable instead of a vibe.
 *
 * Everything is verified against the inventory/world instead of trusting the
 * tool that performed the step: a step that reports success without the item
 * actually appearing counts as a failure.
 */
import vec3Pkg from 'vec3'

import * as actions from './actions.js'

const { Vec3 } = vec3Pkg

const STEP_TIMEOUT_MS = 120_000

export const PLANS = Object.freeze({
  bootstrap: [
    // Adaptive: keep chopping until the bag really holds 4 logs.
    { id: 'wood', label: '砍到 3 个原木', kind: 'ensureWood', options: { logs: 3 } },
    // count is in result items: table 4 + sticks 2 + pickaxe 3 = 9 planks.
    { id: 'planks', label: '合成木板', kind: 'craft', item: 'oak_planks', count: 9 },
    { id: 'table', label: '合成并放下工作台', kind: 'table' },
    { id: 'sticks', label: '合成木棍', kind: 'craft', item: 'stick', count: 2 },
    { id: 'wooden_pickaxe', label: '合成木镐', kind: 'craft', item: 'wooden_pickaxe', count: 1 },
    // 12 stone → 12 cobblestone: 8 for the furnace, 3 for the stone pickaxe, spares.
    { id: 'stone', label: '挖 12 个石头', kind: 'behavior', mode: 'mine', options: { targets: ['stone'], amount: 12 }, equip: 'wooden_pickaxe', allowPartial: true },
    { id: 'stone_pickaxe', label: '合成石镐', kind: 'craft', item: 'stone_pickaxe', count: 1 },
    { id: 'furnace', label: '合成熔炉', kind: 'craft', item: 'furnace', count: 1 }
  ],
  speedrun: [
    { id: 'wood', label: '① 原木 ×3', kind: 'ensureWood', options: { logs: 3 } },
    { id: 'planks', label: '② 木板 ×9', kind: 'craft', item: 'oak_planks', count: 9 },
    { id: 'table', label: '③ 工作台', kind: 'table' },
    { id: 'wooden_pickaxe', label: '④ 木镐', kind: 'craft', item: 'wooden_pickaxe', count: 1 },
    { id: 'stone', label: '⑤ 石头 ×12', kind: 'behavior', mode: 'mine', options: { targets: ['stone'], amount: 12 }, equip: 'wooden_pickaxe', allowPartial: true },
    { id: 'stone_pickaxe', label: '⑥ 石镐', kind: 'craft', item: 'stone_pickaxe', count: 1 },
    { id: 'iron', label: '⑦ 铁矿 ×3', kind: 'behavior', mode: 'mine', options: { targets: ['iron_ore'], amount: 3 }, equip: 'stone_pickaxe' },
    { id: 'furnace', label: '⑧ 熔炉', kind: 'craft', item: 'furnace', count: 1 }
  ]
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const countOf = (bot, name) => bot.inventory.items().filter((item) => item.name === name).reduce((total, item) => total + item.count, 0)

export class SoloRunner {
  /**
   * @param {{ botController: any, config: Record<string, any>, events: any, behaviors: any }} options
   */
  constructor ({ botController, config, events, behaviors, actions: actionsApi = actions }) {
    this.botController = botController
    this.config = config
    this.events = events
    this.behaviors = behaviors
    /** Injectable for tests; the real module by default. */
    this.actions = actionsApi
    this.running = false
    this.plan = null
    this.stepIndex = -1
    this.steps = []
    this.startedAt = 0
    this.finishedAt = 0
    this.error = null
    this.abort = false
    this.onState = null
  }

  get bot () {
    return this.botController?.bot ?? null
  }

  /**
   * Run a plan to completion in the background.
   * @param {"bootstrap"|"speedrun"} planName
   */
  async start (planName = 'bootstrap') {
    if (this.running) throw new Error('SOLO_ALREADY_RUNNING: 单人计划已经在跑，先 stop。')
    if (!this.bot?.entity) throw new Error('MC_BOT_OFFLINE: Bot 不在线，先连接。')
    const plan = PLANS[planName]
    if (!plan) throw new Error(`SOLO_UNKNOWN_PLAN: 未知计划 ${planName}（可用：${Object.keys(PLANS).join(', ')}）`)
    this.running = true
    this.abort = false
    this.plan = planName
    this.error = null
    this.startedAt = Date.now()
    this.finishedAt = 0
    this.stepIndex = 0
    this.steps = plan.map((step) => ({ id: step.id, label: step.label, status: 'pending', ms: 0, detail: '' }))
    this.events?.push?.('solo', `单人计划开始：${planName}（${plan.length} 步）`, { plan: planName })
    this.#emit()
    // Deliberately not awaited: the caller (tool/panel) gets the snapshot at
    // once and watches progress through status.
    this.#loop().catch((error) => {
      this.error = error instanceof Error ? error.message : String(error)
      this.running = false
      this.finishedAt = Date.now()
      this.events?.push?.('error', `单人计划失败：${this.error}`, { plan: this.plan })
      this.#emit()
    })
    return this.snapshot()
  }

  stop (reason = 'stopped') {
    if (!this.running) return this.snapshot()
    this.abort = true
    try {
      this.behaviors?.stop?.(reason)
    } catch {
      /* ignore */
    }
    this.running = false
    this.finishedAt = Date.now()
    this.events?.push?.('solo', `单人计划已停止（${reason}）`, { plan: this.plan })
    this.#emit()
    return this.snapshot()
  }

  snapshot () {
    const elapsedMs = this.startedAt ? (this.finishedAt || Date.now()) - this.startedAt : 0
    return {
      running: this.running,
      plan: this.plan,
      step: this.stepIndex >= 0 ? this.stepIndex : null,
      total: this.steps.length,
      steps: this.steps,
      elapsedMs,
      error: this.error,
      current: this.steps[this.stepIndex] ?? null
    }
  }

  #emit () {
    try {
      this.onState?.(this.snapshot())
    } catch {
      /* ignore */
    }
  }

  async #loop () {
    const plan = PLANS[this.plan]
    for (let index = 0; index < plan.length; index++) {
      if (this.abort) return
      this.stepIndex = index
      const step = plan[index]
      const record = this.steps[index]
      record.status = 'running'
      this.#emit()
      const startedAt = Date.now()
      let ok = false
      try {
        ok = await this.#runStep(step, record)
      } catch (error) {
        record.detail = error instanceof Error ? error.message : String(error)
      }
      record.ms = Date.now() - startedAt
      record.status = ok ? 'done' : 'failed'
      this.#emit()
      if (!ok) {
        this.running = false
        this.finishedAt = Date.now()
        this.error = `${step.label} 失败：${record.detail || '未知原因'}`
        this.events?.push?.('solo', `单人计划中断：${this.error}`, { plan: this.plan, step: step.id })
        this.#emit()
        return
      }
      this.events?.push?.('solo', `单人计划 ${index + 1}/${plan.length}：${step.label}（${record.ms}ms）`, {
        plan: this.plan,
        step: step.id,
        ms: record.ms
      })
    }
    this.running = false
    this.finishedAt = Date.now()
    this.stepIndex = -1
    const total = this.finishedAt - this.startedAt
    this.events?.push?.('solo', `单人计划完成：${this.plan}，总耗时 ${(total / 1000).toFixed(1)}s`, {
      plan: this.plan,
      totalMs: total
    })
    this.#emit()
  }

  async #runStep (step, record) {
    const bot = this.bot
    if (step.equip) await this.#ensureHeld(step.equip)
    switch (step.kind) {
      case 'behavior': {
        const before = step.options?.amount ? this.#progressCount(step) : 0
        await this.#behavior(step.mode, step.options, step.allowPartial === true)
        // Chopped logs stay on the ground; collect before verifying.
        try {
          await this.actions.collectItems(this.botController, { radius: 8 })
        } catch {
          /* ignore: the craft step will complain if the wood is missing */
        }
        const after = this.#progressCount(step)
        if (after <= before && step.options?.amount) {
          const progress = this.behaviors.last?.progress ?? 0
          if (progress > 0) {
            record.detail = `砍下 ${progress} 个（掉落未收全）`
            return true
          }
          throw new Error(`没有取得新的目标（${step.options.amount} 个，行为原因 ${this.behaviors.last?.reason ?? 'unknown'}）`)
        }
        record.detail = `取得 ${after - before} 个`
        return true
      }
      case 'ensureWood': {
        const need = Number(step.options?.logs) || 4
        const have = () => bot.inventory.items().filter((item) => /_log$/.test(item.name)).reduce((sum, item) => sum + item.count, 0)
        for (let attempt = 0; attempt < 3 && have() < need; attempt++) {
          try {
            await this.#behavior('woodcut', { amount: need - have() }, true)
            await this.actions.collectItems(this.botController, { radius: 10 })
          } catch (error) {
            // "no trees" right after spawn is usually the chunk still loading;
            // give the world a moment and try again before giving up.
            record.detail = `第 ${attempt + 1} 次尝试：${error instanceof Error ? error.message : String(error)}`
            await sleep(1_200)
          }
        }
        if (have() < need) throw new Error(`原木不足：需要 ${need}，只有 ${have()}`)
        record.detail = `原木 ${have()}`
        return true
      }
      case 'craft': {
        const before = countOf(bot, step.item)
        const crafted = await this.actions.craftItem(this.botController, { item: step.item, count: step.count })
        if (!crafted?.ok) throw new Error(crafted?.message ?? crafted?.error ?? '合成失败')
        const after = countOf(bot, step.item)
        if (after <= before) throw new Error(`合成后背包里没有 ${step.item}`)
        record.detail = `${step.item} +${after - before}`
        return true
      }
      case 'table': {
        const existing = this.#findTable()
        if (existing) {
          record.detail = '已有工作台'
          return true
        }
        const crafted = await this.actions.craftItem(this.botController, { item: 'crafting_table', count: 1 })
        if (!crafted?.ok) throw new Error(crafted?.message ?? '工作台合成失败')
        const target = this.#freeSpotNearBot()
        const placed = await this.actions.placeBlockAt(this.botController, { ...target, item: 'crafting_table' })
        if (!placed?.ok) throw new Error(placed?.message ?? '工作台放不下')
        record.detail = `放在 ${target.x},${target.y},${target.z}`
        return true
      }
      case 'smelt': {
        const smelted = await this.actions.smeltItem(this.botController, step.options ?? {})
        if (!smelted?.ok) throw new Error(smelted?.message ?? '烧炼失败')
        record.detail = `${smelted.smelted} ×${smelted.count ?? 1}`
        return true
      }
      default:
        throw new Error(`未知步骤类型 ${step.kind}`)
    }
  }

  /** How many units of the behaviour goal are already in the bag. */
  #progressCount (step) {
    const bot = this.bot
    const targets = step.options?.targets ?? []
    if (step.mode === 'woodcut') {
      return bot.inventory.items().filter((item) => /_log$|_planks$/.test(item.name)).reduce((sum, item) => sum + item.count, 0)
    }
    if (step.mode === 'mine' && targets.length > 0) {
      return targets.reduce((sum, name) => sum + countOf(bot, name), 0)
    }
    return 0
  }

  /**
   * Equip an item and wait until the server acknowledges it as held.
   * Mine refuses to start without a pickaxe in hand, so this cannot be a
   * fire-and-forget call.
   */
  async #ensureHeld (item) {
    const bot = this.bot
    if (bot.heldItem?.name === item) return true
    const equipped = await this.actions.equipItem(this.botController, { item })
    if (!equipped?.ok) throw new Error(equipped?.message ?? `无法装备 ${item}`)
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      if (bot.heldItem?.name === item) return true
      await sleep(150)
    }
    throw new Error(`装备 ${item} 后手里仍然是 ${bot.heldItem?.name ?? '空手'}`)
  }

  /** Wait for a behaviour to finish, bounded by STEP_TIMEOUT_MS. */
  async #behavior (mode, options, allowPartial = false) {
    if (!this.behaviors) throw new Error('行为运行器不可用')
    this.behaviors.start(mode, options)
    const deadline = Date.now() + STEP_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.abort) return
      const snapshot = this.behaviors.snapshot()
      if (!snapshot.active) {
        const last = this.behaviors.last
        const finished = !last?.reason || /done|target|完成|reached/i.test(last.reason)
        const hasProgress = (last?.progress ?? 0) > 0
        if (!finished && !(allowPartial && hasProgress)) {
          throw new Error(`行为结束但未完成（${last?.reason ?? 'unknown'}，进度 ${last?.progress ?? 0}）`)
        }
        return last
      }
      await sleep(400)
    }
    this.behaviors.stop('solo timeout')
    throw new Error(`${mode} 超时（${STEP_TIMEOUT_MS / 1000}s）`)
  }

  #findTable () {
    const bot = this.bot
    const id = bot.registry?.blocksByName?.crafting_table?.id
    if (id === undefined) return null
    const found = bot.findBlock({ matching: id, maxDistance: 8 })
    return found ?? null
  }

  #freeSpotNearBot () {
    const position = this.bot.entity.position.floored()
    const bot = this.bot
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = position.x + dx
      const z = position.z + dz
      for (let dy = 0; dy >= -1; dy--) {
        const y = position.y + dy
        const ground = bot.blockAt(new Vec3(x, y - 1, z))
        const at = bot.blockAt(new Vec3(x, y, z))
        if (ground?.name && ground.name !== 'air' && (at?.name === 'air' || at?.name === 'cave_air')) {
          return { x, y, z }
        }
      }
    }
    return { x: position.x + 2, y: position.y, z: position.z }
  }
}











