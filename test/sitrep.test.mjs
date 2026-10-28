import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSitrep } from '../lib/sitrep.js'

const pos = (x, y, z) => ({ x, y, z, distanceTo: (other) => Math.hypot(x - other.x, y - other.y, z - other.z) })

function worldBot ({ blocks = {}, items = [], health = 20, food = 20, entities = {} } = {}) {
  return {
    entity: { position: pos(0, -60, 0) },
    game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 6_000 },
    health,
    food,
    inventory: { items: () => items },
    registry: { entitiesByName: {} },
    entities: { 1: { id: 1, position: pos(0, -60, 0), type: 'player' }, ...entities },
    findBlocks: ({ matching, maxDistance }) => Object.entries(blocks)
      .map(([key, name]) => ({ name, p: key.split(',').map(Number) }))
      .filter(({ name, p }) => matching({ name }) && Math.hypot(p[0], p[1] + 60, p[2]) <= maxDistance)
      .map(({ p }) => ({ x: p[0], y: p[1], z: p[2] }))
  }
}

test('sitrep reports tools, inventory, ores and options', () => {
  const bot = worldBot({
    blocks: { '3,-61,0': 'iron_ore', '4,-61,0': 'coal_ore', '2,-60,0': 'oak_log', '5,-60,0': 'chest' },
    items: [{ name: 'stone_pickaxe', count: 1 }, { name: 'bread', count: 3 }, { name: 'cobblestone', count: 12 }]
  })
  const report = buildSitrep(bot, { radius: 32 })
  assert.equal(report.ok, true)
  assert.equal(report.tools.pickaxe, 'stone_pickaxe')
  assert.equal(report.tools.sword, null)
  assert.equal(report.near.ores.iron_ore, 1)
  assert.equal(report.near.ores.coal_ore, 1)
  assert.equal(report.near.logs.oak_log, 1)
  assert.ok(report.options.some((option) => /矿/.test(option)))
  assert.ok(report.options.some((option) => /箱子/.test(option)))
  assert.ok(report.missing.some((entry) => /剑/.test(entry)), JSON.stringify(report.missing))
  assert.equal(report.time.clock, '12:00')
})

test('sitrep warns about health, hunger and hostiles', () => {
  const bot = worldBot({
    health: 5,
    food: 9,
    entities: { 7: { id: 7, name: 'zombie', type: 'mob', position: pos(4, -60, 0) } }
  })
  const report = buildSitrep(bot, { radius: 16 })
  assert.equal(report.hostiles[0].name, 'zombie')
  assert.ok(report.options.some((option) => /血量偏低/.test(option)))
  assert.ok(report.options.some((option) => /饥饿偏低/.test(option)))
})

test('sitrep says so when nothing is around', () => {
  const bot = worldBot()
  const report = buildSitrep(bot, { radius: 16 })
  assert.equal(report.ok, true)
  assert.ok(report.options.some((option) => /没矿/.test(option)))
  assert.deepEqual(report.hostiles, [])
})

test('sitrep refuses to report for an offline bot', () => {
  const report = buildSitrep({ entity: null }, {})
  assert.equal(report.ok, false)
  assert.match(report.error, /MC_BOT_NOT_CONNECTED/)
})

