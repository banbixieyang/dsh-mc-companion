import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, MaterialGatherer } from '../lib/materials.js'

const pos = (x, y, z) => ({ x, y, z })

function harness ({ items = [], mode = 'survival' } = {}) {
  const bag = new Map(items)
  const bot = {
    entity: { position: pos(0, -60, 0) },
    game: { gameMode: mode },
    inventory: {
      items: () => [...bag.entries()].flatMap(([name, count]) => (count > 0 ? [{ name, count }] : []))
    },
    registry: { blocksByName: { chest: { id: 1, name: 'chest' }, barrel: { id: 2, name: 'barrel' } } },
    findBlocks: () => [],
    blockAt: () => ({ name: 'air' })
  }
  const calls = { behavior: [], craft: [], smelt: [], loot: [] }
  const behaviors = {
    start (mode, options) {
      calls.behavior.push({ mode, options })
      if (mode === 'woodcut') bag.set('oak_log', (bag.get('oak_log') ?? 0) + (options?.amount ?? 1))
      if (mode === 'mine') bag.set('cobblestone', (bag.get('cobblestone') ?? 0) + (options?.amount ?? 1))
      return { active: true }
    },
    stop () {},
    snapshot: () => ({ active: false })
  }
  const actions = {
    async craftItem (_, options) {
      calls.craft.push(options.item)
      const need = options.item === 'oak_planks' ? 1 : 1
      const have = bag.get('oak_log') ?? 0
      if (options.item === 'oak_planks') {
        if (have < need) return { ok: false, error: 'MISSING_MATERIALS' }
        bag.set('oak_log', have - need)
        bag.set('oak_planks', (bag.get('oak_planks') ?? 0) + 4 * options.count)
        return { ok: true }
      }
      bag.set(options.item, (bag.get(options.item) ?? 0) + 1)
      return { ok: true }
    },
    async smeltItem (_, options) {
      calls.smelt.push(options)
      bag.set('iron_ingot', 3)
      return { ok: true, smelted: 'iron_ingot', count: 3 }
    },
    async containerAction (_, options) {
      calls.loot.push(options)
      return { ok: true, taken: 0 }
    },
    async collectItems () { return { ok: true } }
  }
  return { bot, controller: { bot }, behaviors, actions, calls, bag }
}

test('classify maps items to their source', () => {
  assert.deepEqual(classify('oak_planks'), { kind: 'planks', source: 'oak_log' })
  assert.deepEqual(classify('birch_log'), { kind: 'log', block: 'birch_log' })
  assert.deepEqual(classify('iron_ingot'), { kind: 'ingot', ore: 'iron_ore' })
  assert.deepEqual(classify('cobblestone'), { kind: 'stone', block: 'stone' })
  assert.deepEqual(classify('glass'), { kind: 'glass' })
  assert.deepEqual(classify('diamond_block'), { kind: 'loot', block: 'diamond_block' })
})

test('plan reports what is missing and where it comes from', () => {
  const { controller, behaviors, actions } = harness({ items: [['oak_planks', 5]] })
  const gatherer = new MaterialGatherer({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  const plan = gatherer.plan({ oak_planks: 20, cobblestone: 8 })
  assert.equal(plan.items.find((item) => item.name === 'oak_planks').missing, 15)
  assert.equal(plan.items.find((item) => item.name === 'cobblestone').missing, 8)
})

test('acquire chops wood and crafts planks', async () => {
  const { controller, behaviors, actions, calls, bag } = harness()
  const gatherer = new MaterialGatherer({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  const result = await gatherer.acquire({ required: { oak_planks: 8 } })
  assert.equal(result.ok, true, JSON.stringify(result.stillMissing))
  assert.ok(calls.behavior.some((call) => call.mode === 'woodcut'), 'should chop trees')
  assert.ok(calls.craft.includes('oak_planks'), 'should craft the planks')
  assert.ok((bag.get('oak_planks') ?? 0) >= 8)
})

test('acquire mines stone through the mine behaviour', async () => {
  const { controller, behaviors, actions, calls } = harness()
  const gatherer = new MaterialGatherer({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  const result = await gatherer.acquire({ required: { cobblestone: 6 } })
  assert.equal(result.ok, true, JSON.stringify(result.stillMissing))
  assert.ok(calls.behavior.some((call) => call.mode === 'mine' && call.options?.targets?.includes('stone')))
})

test('creative with fill allowance skips gathering entirely', async () => {
  const { controller, behaviors, actions, calls } = harness({ mode: 'creative' })
  const gatherer = new MaterialGatherer({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  const result = await gatherer.acquire({ required: { diamond_block: 64 }, allowCreativeFill: true })
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'creative')
  assert.equal(calls.behavior.length, 0)
})

test('impossible items are reported instead of silently ignored', async () => {
  const { controller, behaviors, actions } = harness()
  const gatherer = new MaterialGatherer({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  const result = await gatherer.acquire({ required: { diamond_block: 4 }, rounds: 1 })
  assert.equal(result.ok, false)
  assert.ok(result.stillMissing.diamond_block, JSON.stringify(result.stillMissing))
})
