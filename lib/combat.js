/**
 * Combat strategy.
 *
 * Not "attack the nearest thing": the advisor picks the best weapon the bot
 * actually owns, keeps a per-mob strategy (rush a skeleton, never melee a
 * creeper, keep out of a blaze's line), decides when to eat, and retreats at
 * low health instead of dying for the kill.
 *
 * It never targets players.
 */
import * as actions from './actions.js'

const WEAPON_SCORE = [
  [/^netherite_sword$/, 100],
  [/^diamond_sword$/, 90],
  [/^iron_sword$/, 80],
  [/^stone_sword$/, 70],
  [/^golden_sword$/, 60],
  [/^wooden_sword$/, 50],
  [/^netherite_axe$/, 45],
  [/^diamond_axe$/, 40],
  [/^iron_axe$/, 35],
  [/^stone_axe$/, 30],
  [/^wooden_axe$/, 25],
  [/_pickaxe$/, 20],
  [/_shovel$/, 10]
]

const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet']

/** Per-mob tactics. `keep` is the distance to hold, `rush` means close fast. */
export const TACTICS = Object.freeze({
  creeper: { keep: 4.5, rush: false, note: '躲爆炸：打一下退三步，别贴身' },
  skeleton: { keep: 0.8, rush: true, note: '速贴近战，别在箭线上停留' },
  stray: { keep: 0.8, rush: true, note: '速贴近战' },
  spider: { keep: 1.2, rush: true, note: '贴脸打，跳劈难躲' },
  cave_spider: { keep: 1.0, rush: true, note: '贴脸打，注意中毒' },
  zombie: { keep: 1.6, rush: true, note: '正常近战' },
  drowned: { keep: 2.0, rush: true, note: '在水里注意三叉戟' },
  husk: { keep: 1.6, rush: true, note: '正常近战' },
  witch: { keep: 6.0, rush: false, note: '别喝药水，拉远用弓或跑' },
  enderman: { keep: 2.5, rush: false, note: '别直视；打了就要一口气打死' },
  blaze: { keep: 3.0, rush: true, note: '速贴脸，躲火球' },
  piglin: { keep: 2.0, rush: true, note: '穿金装不然会敌对' },
  hoglin: { keep: 3.0, rush: false, note: '侧身打，别被顶进岩浆' },
  ghast: { keep: 8.0, rush: false, note: '远程或躲火球，别在开阔地久留' },
  phantom: { keep: 1.5, rush: true, note: '白天会烧，可等到天亮' },
  pillager: { keep: 2.0, rush: true, note: '近距离优先弩手' },
  vindicator: { keep: 2.0, rush: true, note: '躲斧头，速杀' },
  ravager: { keep: 5.0, rush: false, note: '绕后打，别正面' },
  slime: { keep: 2.0, rush: true, note: '小史莱姆会分裂，用剑快点' },
  magma_cube: { keep: 3.0, rush: false, note: '别贴身，会烧' },
  silverfish: { keep: 1.5, rush: true, note: '速杀，别引来更多' },
  warden: { keep: 20.0, rush: false, note: '跑，不要打' }
})

const DEFAULT_TACTIC = { keep: 2.0, rush: true, note: '常规近战' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round1 = (value) => Math.round(value * 10) / 10

export class CombatAdvisor {
  constructor ({ botController, config, events }) {
    this.botController = botController
    this.config = config
    this.events = events
    this.lastFight = null
  }

  get bot () {
    return this.botController?.bot ?? null
  }

  /** Best weapon in the bag, or null. */
  bestWeapon () {
    const bot = this.bot
    if (!bot?.inventory) return null
    let best = null
    for (const item of bot.inventory.items()) {
      for (const [pattern, score] of WEAPON_SCORE) {
        if (pattern.test(item.name) && (!best || score > best.score)) {
          best = { name: item.name, score, count: item.count }
        }
      }
    }
    return best
  }

  /** Which armour slots are filled and how good the pieces are. */
  armor () {
    const bot = this.bot
    const slots = {}
    for (const slot of ARMOR_SLOTS) {
      const item = bot?.inventory?.slots?.[bot.inventory?.heldItemSlot === undefined ? -1 : -1]
      slots[slot] = item?.name ?? null
    }
    // mineflayer exposes equipped armour through bot.entity.equipment
    const equipment = bot?.entity?.equipment ?? []
    const names = equipment.map((entry) => entry?.name ?? null)
    const mapping = { head: names[4] ?? null, torso: names[3] ?? null, legs: names[2] ?? null, feet: names[1] ?? null }
    const score = Object.values(mapping).filter(Boolean).length
    return { slots: mapping, score, points: score * 2 }
  }

  tacticFor (name) {
    return TACTICS[name] ?? DEFAULT_TACTIC
  }

  /** Hostiles within radius, nearest first, players excluded. */
  targets (radius = 16) {
    const bot = this.bot
    if (!bot?.entity) return []
    const rows = []
    for (const entity of Object.values(bot.entities ?? {})) {
      if (!entity || entity === bot.entity || entity.type === 'player' || !entity.name) continue
      if (!/zombie|skeleton|creeper|spider|witch|enderman|blaze|piglin|hoglin|phantom|drowned|pillager|vindicator|ravager|silverfish|slime|magma|ghast|stray|husk|warden|cave_spider/i.test(entity.name)) continue
      const distance = bot.entity.position.distanceTo(entity.position)
      if (distance > radius) continue
      rows.push({ entity, name: entity.name, distance, tactic: this.tacticFor(entity.name) })
    }
    return rows.sort((a, b) => a.distance - b.distance)
  }

  /** What the bot would do right now, without doing it. */
  advice ({ radius = 16 } = {}) {
    const bot = this.bot
    if (!bot?.entity) return { online: false }
    const weapon = this.bestWeapon()
    const armor = this.armor()
    const nearby = this.targets(radius)
    const health = typeof bot.health === 'number' ? bot.health : 20
    const food = typeof bot.food === 'number' ? bot.food : 20
    const fleeAt = Number(this.config?.autopilot?.fleeHealth ?? 6)
    let recommendation = 'idle'
    if (nearby.length > 0) {
      recommendation = health <= fleeAt ? 'retreat' : 'engage'
    } else if (health <= 14 || food <= Number(this.config?.autopilot?.eatThreshold ?? 18)) {
      recommendation = 'regroup'
    }
    return {
      online: true,
      health: round1(health),
      food,
      weapon,
      armor,
      nearby: nearby.map((row) => ({ name: row.name, distance: round1(row.distance), note: row.tactic.note })),
      recommendation,
      reason: recommendation === 'retreat'
        ? `血量 ${round1(health)} ≤ ${fleeAt}，先跑`
        : recommendation === 'engage'
          ? `最近威胁 ${nearby[0].name}（${round1(nearby[0].distance)} 格）`
          : recommendation === 'regroup'
            ? '没威胁但状态差，先吃/回血'
            : '周围安全'
    }
  }

  /**
   * Fight the nearest hostiles with the per-mob tactics.
   * @returns {Promise<{ok: boolean, killed: number, reason: string}>}
   */
  async engage ({ radius = 16, targets = null, timeoutMs = 45_000 } = {}) {
    const bot = this.bot
    if (!bot?.entity) throw new Error('MC_BOT_NOT_OFFLINE: Bot 不在线。')
    const weapon = this.bestWeapon()
    if (weapon) {
      const equipped = await actions.equipItem(this.botController, { item: weapon.name })
      if (!equipped?.ok) this.events?.push?.('error', `武器装备失败：${equipped?.message ?? weapon.name}`)
    }
    const fleeAt = Number(this.config?.autopilot?.fleeHealth ?? 6)
    const startedAt = Date.now()
    let killed = 0
    let reason = 'timeout'
    const killedIds = new Set()
    while (Date.now() - startedAt < timeoutMs) {
      const health = typeof bot.health === 'number' ? bot.health : 20
      if (health <= fleeAt) {
        reason = 'retreat'
        this.events?.push?.('combat', `血量 ${round1(health)} 太低，脱离战斗`, { health })
        break
      }
      const list = this.targets(radius).filter((row) => !killedIds.has(row.entity.id))
      const filtered = targets ? list.filter((row) => targets.includes(row.name)) : list
      if (filtered.length === 0) {
        reason = killed > 0 ? 'cleared' : 'no_targets'
        break
      }
      const target = filtered[0]
      const entity = target.entity
      const distance = bot.entity.position.distanceTo(entity.position)
      const tactic = target.tactic
      if (distance > tactic.keep + 1.5) {
        const nav = await import('./navigation.js')
        await nav.gotoPosition(this.botController, {
          x: Math.floor(entity.position.x),
          y: Math.floor(entity.position.y),
          z: Math.floor(entity.position.z),
          tolerance: Math.max(1.2, tactic.keep),
          timeoutMs: 6_000
        }).catch(() => null)
      }
      try {
        await bot.lookAt(entity.position.offset(0, 1.4, 0), true)
      } catch {
        /* ignore */
      }
      try {
        await bot.attack(entity)
      } catch {
        /* ignore */
      }
      await sleep(120)
      // Creepers: hit and step back so the blast does not land on us.
      if (target.name === 'creeper' && distance < 3) {
        const away = {
          x: Math.round(bot.entity.position.x - entity.position.x + bot.entity.position.x),
          y: Math.round(bot.entity.position.y),
          z: Math.round(bot.entity.position.z - entity.position.z + bot.entity.position.z)
        }
        const nav = await import('./navigation.js')
        await nav.gotoPosition(this.botController, { ...away, tolerance: 1.5, timeoutMs: 4_000 }).catch(() => null)
      }
      if (!bot.entities[entity.id]) {
        killed += 1
        killedIds.add(entity.id)
        this.events?.push?.('combat', `击杀 ${target.name}（剩 ${Math.max(0, filtered.length - 1)} 个）`, { name: target.name })
      }
    }
    this.lastFight = { at: Date.now(), killed, reason, elapsedMs: Date.now() - startedAt }
    return { ok: true, killed, reason, elapsedMs: Date.now() - startedAt, weapon: weapon?.name ?? null }
  }
}

export { DEFAULT_TACTIC }
