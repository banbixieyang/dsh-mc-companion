/**
 * What the behaviours are allowed to touch.
 *
 * These tables are deliberately conservative: the companion is a *guest* on
 * someone's server, so anything that is clearly player-built, container-like or
 * administrative is refused before a single packet is sent.
 */

/** Tree blocks: logs, wood, stems and hyphae, including stripped variants. */
const TREE_PATTERN = /(_log|_wood|_stem|_hyphae)$/

export function isLogBlock (name) {
  return typeof name === 'string' && TREE_PATTERN.test(name)
}

/** Ores worth mining by default (deepslate variants included). */
export const DEFAULT_ORES = [
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
  'deepslate_copper_ore',
  'deepslate_gold_ore',
  'deepslate_redstone_ore',
  'deepslate_lapis_ore',
  'deepslate_diamond_ore',
  'deepslate_emerald_ore',
  'nether_quartz_ore',
  'nether_gold_ore',
  'ancient_debris'
]

/**
 * Hostile mobs the bot may attack by default. Creepers are intentionally not
 * included: fighting one next to a build is how bots turn buildings into holes.
 * Pass `targets` explicitly to opt in.
 */
export const DEFAULT_FIGHT_TARGETS = [
  'zombie',
  'husk',
  'drowned',
  'skeleton',
  'stray',
  'spider',
  'cave_spider',
  'pillager',
  'vindicator',
  'witch',
  'slime',
  'magma_cube'
]

/**
 * Blocks that are never dug, regardless of what a behaviour targets: storage,
 * beds, signs, banners, administrative blocks and anything a player would miss.
 */
export const DIG_BLACKLIST_PATTERNS = [
  /(^|_)chest$/, // chest, trapped_chest, ender_chest
  /_shulker_box$/,
  /_bed$/,
  /_sign$/,
  /_banner$/,
  /_skull$/,
  /_head$/,
  /^spawner$/,
  /^trial_spawner$/,
  /^vault$/,
  /^beacon$/,
  /^conduit$/,
  /^lectern$/,
  /^enchanting_table$/,
  /^anvil$/,
  /^respawn_anchor$/,
  /^command_block$/,
  /^chain_command_block$/,
  /^repeating_command_block$/,
  /^structure_block$/,
  /^jigsaw$/,
  /^barrier$/,
  /^light$/,
  /^nether_portal$/,
  /^end_portal/,
  /^reinforced_deepslate$/
]

/**
 * True when a block name must not be dug.
 * @param {string} name block name without namespace
 * @param {string[]} [extra] additional exact names from config
 */
export function isProtectedBlock (name, extra = []) {
  if (typeof name !== 'string') return true
  if (extra.includes(name)) return true
  return DIG_BLACKLIST_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * True when another player is within `distance` of `position`; the bot must not
 * dig/place there while `protectPlayers` is on.
 * @param {any} bot mineflayer bot
 * @param {{x:number,y:number,z:number}} position
 * @param {number} distance
 */
export function nearOtherPlayer (bot, position, distance) {
  const own = bot?.entity?.position
  if (!position) return false
  for (const player of Object.values(bot?.players ?? {})) {
    const entity = player?.entity
    if (!entity?.position) continue
    if (own && entity.position.distanceTo(own) < 0.001) continue // that is us
    if (entity.position.distanceTo(position) <= distance) return true
  }
  return false
}

/**
 * Normalise a caller-supplied name list against a registry of known names.
 * Unknown names are rejected instead of silently ignored, so a typo can never
 * turn into "mine everything".
 * @param {string[]} names
 * @param {(name: string) => boolean} exists
 * @param {string} what
 */
export function validateTargets (names, exists, what) {
  if (!Array.isArray(names) || names.length === 0) throw new Error(`MC_BEHAVIOR_INVALID_ARGS: ${what} 不能为空。`)
  const unknown = names.filter((name) => !exists(String(name).replace(/^minecraft:/, '')))
  if (unknown.length > 0) throw new Error(`MC_BEHAVIOR_INVALID_ARGS: 未知的 ${what}：${unknown.join(', ')}。`)
  return names.map((name) => String(name).replace(/^minecraft:/, ''))
}
