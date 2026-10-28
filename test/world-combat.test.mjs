import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { WorldModel, STRUCTURE_MARKERS, STRUCTURE_KINDS } from '../lib/world.js'
import { CombatAdvisor, TACTICS } from '../lib/combat.js'
import { normalizeConfig } from '../lib/config.js'

const pos = (x, y, z) => ({ x, y, z, distanceTo: (other) => Math.hypot(x - other.x, y - other.y, z - other.z), offset: (dx, dy, dz) => pos(x + dx, y + dy, z + dz) })

/** A bot whose world is a fixed set of blocks, so census/structure lookups are exact. */
function worldBot ({ blocks = {}, position = pos(0, -60, 0), timeOfDay = 1000, dimension = 'overworld', health = 20, food = 20, entities = {}, items = [] } = {}) {
  return {
    entity: { position, equipment: [] },
    game: { dimension, gameMode: 'survival' },
    time: { timeOfDay },
    health,
    food,
    world: { getColumn: () => ({ biome: { name: 'plains' } }) },
    blockAt: (p) => {
      const key = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
      const name = blocks[key]
      return name ? { name, biome: { name: 'plains' } } : { name: 'air', biome: { name: 'plains' } }
    },
    findBlocks: ({ matching, maxDistance }) => Object.entries(blocks)
      .map(([key, name]) => ({ key, name, p: key.split(',').map(Number) }))
      .filter(({ name, p }) => matching({ name }) && Math.hypot(p[0] - position.x, p[1] - position.y, p[2] - position.z) <= maxDistance)
      .map(({ p }) => ({ x: p[0], y: p[1], z: p[2] })),
    registry: { entitiesByName: {} },
    entities: { 1: { id: 1, position, type: 'player' }, ...entities },
    inventory: { items: () => items, slots: [] }
  }
}

test('census counts the interesting blocks inside the radius only', () => {
  const bot = worldBot({
    blocks: {
      '2,-60,0': 'iron_ore',
      '3,-60,0': 'iron_ore',
      '1,-60,1': 'coal_ore',
      '5,-60,0': 'oak_log',
      '40,-60,0': 'diamond_ore' // outside a 16 block radius
    }
  })
  const world = new WorldModel({ botController: { bot }, config: normalizeConfig({}), events: { push () {} } })
  const census = world.census({ radius: 16 })
  assert.equal(census.ores.iron_ore, 2)
  assert.equal(census.ores.coal_ore, 1)
  assert.equal(census.ores.diamond_ore, undefined, 'outside the radius must not be counted')
  assert.equal(census.treeCount, 1)
  assert.equal(census.oreCount, 3)
})

test('structure detection uses each kind\'s marker block', () => {
  const bot = worldBot({ blocks: { '10,-59,0': 'bell', '30,-60,0': 'end_portal_frame' } })
  const world = new WorldModel({ botController: { bot }, config: normalizeConfig({}), events: { push () {} } })
  const village = world.findStructure('village', { radius: 64 })
  assert.equal(village.kind, 'village')
  assert.equal(village.marker, 'bell')
  assert.equal(village.position.x, 10)
  assert.ok(Math.abs(village.distance - 10) < 0.01)

  const survey = world.survey({ radius: 64 })
  assert.ok(survey.found.village)
  assert.ok(survey.found.stronghold)

  assert.equal(world.findStructure('bastion', { radius: 64 }), null)
  assert.throws(() => world.findStructure('atlantis'), /WORLD_UNKNOWN_STRUCTURE/)
})

test('structures cover the speedrun-relevant kinds', () => {
  for (const kind of ['village', 'ruined_portal', 'stronghold', 'fortress', 'bastion']) {
    assert.ok(STRUCTURE_MARKERS[kind], `${kind} needs markers`)
    assert.ok(STRUCTURE_KINDS.includes(kind))
  }
})

test('time of day maps to a readable clock', () => {
  const noon = new WorldModel({ botController: { bot: worldBot({ timeOfDay: 6_000 }) }, config: {}, events: { push () {} } })
  assert.equal(noon.timeOfDay.clock, '12:00')
  assert.equal(noon.timeOfDay.isDay, true)
  const midnight = new WorldModel({ botController: { bot: worldBot({ timeOfDay: 18_000 }) }, config: {}, events: { push () {} } })
  assert.equal(midnight.timeOfDay.clock, '00:00')
  assert.equal(midnight.timeOfDay.isDay, false)
})

test('waypoints survive a restart through the memory file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mc-world-'))
  const file = path.join(dir, 'world.json')
  const first = new WorldModel({ botController: { bot: worldBot() }, config: {}, events: { push () {} }, memoryFile: file })
  await first.load()
  await first.remember('base', { x: 12, y: -60, z: -3 })

  const second = new WorldModel({ botController: { bot: worldBot() }, config: {}, events: { push () {} }, memoryFile: file })
  await second.load()
  assert.deepEqual(second.recall('base'), { x: 12, y: -60, z: -3, at: second.recall('base').at })
  assert.equal(second.recall('nope'), null)
})

test('hostiles are listed but players are never targets', () => {
  const bot = worldBot({
    entities: {
      2: { id: 2, name: 'zombie', type: 'mob', position: pos(3, -60, 0) },
      3: { id: 3, name: 'creeper', type: 'mob', position: pos(9, -60, 0) },
      4: { id: 4, name: 'cow', type: 'mob', position: pos(4, -60, 4) }
    }
  })
  const world = new WorldModel({ botController: { bot }, config: {}, events: { push () {} } })
  const hostiles = world.hostiles(16)
  assert.deepEqual(hostiles.map((row) => row.name), ['zombie', 'creeper'])
  const combat = new CombatAdvisor({ botController: { bot }, config: {}, events: { push () {} } })
  const targets = combat.targets(16)
  assert.ok(targets.every((row) => row.name !== ' ') && targets.every((row) => row.entity.type !== 'player'))
  assert.equal(targets[0].name, 'zombie')
})

test('combat picks the best weapon it actually owns', () => {
  const bot = worldBot({
    items: [
      { name: 'wooden_sword', count: 1 },
      { name: 'iron_sword', count: 1 },
      { name: 'stone_axe', count: 1 },
      { name: 'stone_pickaxe', count: 1 },
      { name: 'bread', count: 3 }
    ]
  })
  const combat = new CombatAdvisor({ botController: { bot }, config: {}, events: { push () {} } })
  assert.equal(combat.bestWeapon().name, 'iron_sword')
})

test('combat advice retreats at low health and engages otherwise', () => {
  const zombie = { 2: { id: 2, name: 'zombie', type: 'mob', position: pos(3, -60, 0) } }
  const healthy = new CombatAdvisor({
    botController: { bot: worldBot({ health: 20, food: 20, entities: zombie, items: [{ name: 'iron_sword', count: 1 }] }) },
    config: normalizeConfig({}),
    events: { push () {} }
  })
  const engage = healthy.advice({ radius: 16 })
  assert.equal(engage.recommendation, 'engage')
  assert.match(engage.reason, /zombie/)

  const hurt = new CombatAdvisor({
    botController: { bot: worldBot({ health: 4, food: 20, entities: zombie }) },
    config: normalizeConfig({}),
    events: { push () {} }
  })
  assert.equal(hurt.advice({ radius: 16 }).recommendation, 'retreat')

  const calm = new CombatAdvisor({ botController: { bot: worldBot({ health: 20, food: 20 }) }, config: normalizeConfig({}), events: { push () {} } })
  const idle = calm.advice({ radius: 16 })
  assert.equal(idle.recommendation, 'idle')
  assert.deepEqual(idle.nearby, [])
})

test('per-mob tactics keep creepers away and rush skeletons', () => {
  assert.ok(TACTICS.creeper.keep >= 4 && TACTICS.creeper.rush === false)
  assert.equal(TACTICS.skeleton.rush, true)
  assert.ok(TACTICS.warden.keep >= 16)
  const combat = new CombatAdvisor({ botController: { bot: worldBot() }, config: {}, events: { push () {} } })
  assert.equal(combat.tacticFor('zombie').note, '正常近战')
  assert.deepEqual(combat.tacticFor('unknown_mob').keep, 2.0)
})

test('speedrun config defaults to off with sane sub-switches', () => {
  const config = normalizeConfig({})
  assert.equal(config.speedrun.enabled, false)
  assert.equal(config.speedrun.structureHunt, true)
  assert.equal(config.speedrun.combat, true)
  assert.ok(config.speedrun.targetShipTimeMs >= 60_000)
})
