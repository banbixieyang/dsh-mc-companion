/**
 * Situation report: one compact snapshot the model reads before deciding.
 *
 * The point is to keep the model in charge. Instead of "the script says mine
 * iron", the report says what is actually here (ores, trees, chests, hostiles,
 * tools, health, missing prerequisites) and what the options are — the model
 * picks. Everything is short on purpose: it is meant to be cheap to read often.
 */
const ORE_NAMES = [
  'coal_ore',
  'iron_ore',
  'copper_ore',
  'gold_ore',
  'redstone_ore',
  'lapis_ore',
  'diamond_ore',
  'emerald_ore',
  'deepslate_coal_ore',
  'deepslate_iron_ore',
  'deepslate_gold_ore',
  'deepslate_diamond_ore',
  'nether_quartz_ore',
  'ancient_debris'
]

const TOOL_KINDS = {
  pickaxe: /_pickaxe$/,
  axe: /_axe$/,
  sword: /_sword$/,
  shovel: /_shovel$/,
  hoe: /_hoe$/
}

const round1 = (value) => Math.round(value * 10) / 10

export function buildSitrep (bot, { radius = 32, world = null } = {}) {
  if (!bot?.entity) return { ok: false, error: 'MC_BOT_NOT_CONNECTED', message: 'Bot 不在线。' }
  const position = bot.entity.position
  const items = bot.inventory?.items?.() ?? []
  const counts = {}
  for (const item of items) counts[item.name] = (counts[item.name] ?? 0) + item.count

  const tools = {}
  for (const [kind, pattern] of Object.entries(TOOL_KINDS)) {
    const found = items.filter((item) => pattern.test(item.name)).sort((a, b) => b.count - a.count)[0]
    tools[kind] = found ? found.name : null
  }

  const r = Math.max(8, Math.min(96, Number(radius) || 32))
  const scan = (names) => {
    const out = {}
    for (const name of names) {
      const found = bot.findBlocks({ matching: (block) => block?.name === name, maxDistance: r, count: 256 })
      if (found.length > 0) out[name] = found.length
    }
    return out
  }

  const ores = scan(ORE_NAMES)
  const logs = scan(['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'])
  const utility = scan(['chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'water', 'lava', 'bed'])

  const hostiles = []
  for (const entity of Object.values(bot.entities ?? {})) {
    if (!entity || entity === bot.entity || entity.type === 'player' || !entity.name) continue
    if (!/zombie|skeleton|creeper|spider|witch|enderman|blaze|piglin|phantom|drowned|pillager|vindicator|ravager|silverfish|slime|magma|ghast|warden/i.test(entity.name)) continue
    const distance = position.distanceTo(entity.position)
    if (distance <= 16) hostiles.push({ name: entity.name, distance: round1(distance) })
  }
  hostiles.sort((a, b) => a.distance - b.distance)

  const health = typeof bot.health === 'number' ? round1(bot.health) : null
  const food = typeof bot.food === 'number' ? bot.food : null
  const time = bot.time ? { clock: clockOf(bot.time.timeOfDay), isDay: bot.time.timeOfDay < 12_000 } : null

  const missing = []
  if (!tools.pickaxe) missing.push('镐（挖石头/矿物需要）')
  if (!tools.axe) missing.push('斧（砍树更快）')
  if (!tools.sword) missing.push('剑（战斗）')
  if ((counts.crafting_table ?? 0) === 0 && Object.keys(logs).length === 0 && (counts.oak_planks ?? 0) === 0) {
    missing.push('木头（合成工作台）')
  }
  if ((counts.coal ?? 0) + (counts.charcoal ?? 0) === 0 && !ores.coal_ore) missing.push('燃料（煤/木炭）')

  const options = []
  if (Object.keys(ores).length > 0) {
    const best = Object.entries(ores).sort((a, b) => b[1] - a[1])[0]
    options.push(`附近有矿：${best[0]} ×${best[1]}（半径 ${r}）`)
  } else {
    options.push(`半径 ${r} 内没矿：可以往地下挖，或换方向探索`)
  }
  if (Object.keys(logs).length > 0) options.push(`有树可砍（${Object.values(logs).reduce((a, b) => a + b, 0)} 个原木）`)
  if (utility.chest || utility.barrel) options.push(`附近有箱子，可以翻材料`)
  if (utility.furnace) options.push('附近有熔炉，可以直接烧')
  if (hostiles.length > 0) options.push(`敌对生物 ${hostiles.length} 个（最近 ${hostiles[0].name} ${hostiles[0].distance} 格）`)
  if (health !== null && health <= 8) options.push('血量偏低：先撤退/吃东西')
  if (food !== null && food <= 12) options.push('饥饿偏低：找吃的')
  if (time && !time.isDay) options.push('天黑了：可以睡觉或点灯')

  return {
    ok: true,
    position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
    dimension: bot.game?.dimension ?? null,
    gameMode: bot.game?.gameMode ?? null,
    time,
    health,
    food,
    tools,
    counts: Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, count]) => `${name}×${count}`),
    near: { ores, logs, utility, radius: r },
    hostiles: hostiles.slice(0, 5),
    missing,
    options,
    world: world ? world.snapshot() : null
  }
}

function clockOf (ticks) {
  if (typeof ticks !== 'number') return null
  const hours = ((ticks + 6_000) % 24_000) / 1_000
  const hh = Math.floor(hours)
  const mm = Math.floor((hours - hh) * 60)
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

