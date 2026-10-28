#!/usr/bin/env node
/**
 * Player capabilities: inventory, equipment, eating, dropping, breaking,
 * placing, attacking, respawning, crafting, containers — and the idle
 * autopilot that uses them when nobody is driving.
 *
 * Stub bots only: the point is the decision table (refuse protected blocks,
 * never attack players, don't act while a behaviour owns the loop), while the
 * live-server proof lives in test/capabilities.integration.mjs.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import * as actions from '../lib/actions.js'
import { Autopilot, AUTOPILOT_DEFAULTS } from '../lib/autopilot.js'
import { normalizeConfig } from '../lib/config.js'
import { EventLog } from '../lib/events.js'

const item = (name, count = 1, slot = 36, type = 1) => ({ name, count, slot, type })

function stub ({ items = [], blocks = [], health = 20, food = 20, target = null, entities = {}, players = {} } = {}) {
  const world = blocks.map((entry) => ({ ...entry }))
  const calls = { dig: [], place: [], attack: [], consume: 0, respawn: 0, equip: [], craft: [], toss: [] }
  const bot = {
    health,
    food,
    isSleeping: false,
    game: { gameMode: 'creative' },
    entity: { position: new Vec3(0, -60, 0), id: 1 },
    entities: { 1: { id: 1, name: 'player', type: 'player', position: new Vec3(0, -60, 0) }, ...entities },
    players,
    inventory: {
      items: () => items,
      slots: {},
      emptySlotCount: () => 20
    },
    get heldItem () {
      return items[0] ?? null
    },
    registry: {
      itemsByName: Object.fromEntries(['oak_log', 'oak_planks', 'stick', 'iron_ore', 'iron_ingot', 'coal', 'bread'].map((name, index) => [name, { id: index + 100, name }])),
      blocksByName: { crafting_table: { name: 'crafting_table' }, furnace: { name: 'furnace' } }
    },
    findBlocks: ({ matching, maxDistance }) => world
      .filter((entry) => matching({ name: entry.name }))
      .map((entry) => new Vec3(entry.x, entry.y, entry.z))
      .filter((position) => position.distanceTo(bot.entity.position) <= maxDistance),
    blockAt: (position) => {
      const entry = world.find((e) => e.x === position.x && e.y === position.y && e.z === position.z)
      return entry ? { name: entry.name, position: new Vec3(entry.x, entry.y, entry.z) } : null
    },
    canDigBlock: () => true,
    async dig (block) {
      calls.dig.push(block.name)
    },
    async placeBlock (reference, face) {
      calls.place.push({ reference: reference.name, face: [face.x, face.y, face.z] })
    },
    async equip (entry, destination) {
      calls.equip.push({ name: entry.name, destination })
    },
    async consume () {
      calls.consume += 1
      bot.food = 20
    },
    async toss (type, metadata, count) {
      calls.toss.push({ type, count })
    },
    attack (entity) {
      calls.attack.push(entity.name)
    },
    async respawn () {
      calls.respawn += 1
      bot.health = 20
    },
    activateItem: async () => {},
    recipesFor: () => (target === null ? [] : [{}]),
    recipesAll: () => (target === null ? [] : [{}]),
    async craft (recipe, count) {
      calls.craft.push(count)
    },
    _client: { write () {} },
    pathfinder: { setGoal () {}, isMoving: () => false },
    on () {},
    once () {},
    removeListener () {},
    off () {}
  }
  const controller = {
    bot,
    config: normalizeConfig({}),
    behaviors: { snapshot: () => ({ active: false }) },
    build: null,
    pathfinder: {
      goals: {
        GoalNear: class { constructor (x, y, z, range) { Object.assign(this, { x, y, z, range }) } },
        GoalXZ: class { constructor (x, z) { Object.assign(this, { x, z }) } }
      }
    }
  }
  return { bot, controller, calls }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('inventory summary counts what the model needs', () => {
  const { bot } = stub({
    items: [item('oak_planks', 12), item('bread', 3), item('iron_pickaxe', 1), item('stone', 30)]
  })
  const summary = actions.inventorySummary(bot)
  assert.equal(summary.held.name, 'oak_planks')
  assert.equal(summary.counts.food, 3)
  assert.equal(summary.counts.tools, 1)
  assert.equal(summary.counts.blocks, 42, 'planks + stone are both placeable blocks')
  assert.equal(summary.counts.total, 46)
  assert.equal(actions.findItem(bot, 'minecraft:bread').name, 'bread')
  assert.equal(actions.findItem(bot, 'diamond'), null)
})

test('eating refuses when there is no food and skips at full hunger', async () => {
  const empty = stub({ items: [] })
  assert.equal((await actions.eatFood(empty.controller)).error, 'NO_FOOD')

  const full = stub({ items: [item('bread', 2)], food: 20 })
  const result = await actions.eatFood(full.controller)
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(full.calls.consume, 0)

  const hungry = stub({ items: [item('bread', 2)], food: 8 })
  const ate = await actions.eatFood(hungry.controller)
  assert.equal(ate.ok, true)
  assert.equal(ate.ate, 'bread')
  assert.equal(hungry.calls.consume, 1)
})

test('equipping picks the right destination and refuses empty', async () => {
  const { controller, calls } = stub({ items: [item('iron_pickaxe', 1), item('iron_helmet', 1)] })
  const equipped = await actions.equipItem(controller, { item: 'iron_pickaxe' })
  assert.equal(equipped.ok, true)
  assert.equal(equipped.destination, 'hand')
  assert.deepEqual(calls.equip[0], { name: 'iron_pickaxe', destination: 'hand' })

  const helmet = await actions.equipItem(controller, { destination: 'head' })
  assert.equal(helmet.equipped, 'iron_helmet')

  const nothing = stub({ items: [] })
  assert.equal((await actions.equipItem(nothing.controller, { destination: 'head' })).error, 'ITEM_NOT_FOUND')
})

test('breaking refuses protected blocks and blocks next to players', async () => {
  const protectedBlock = stub({ blocks: [{ name: 'chest', x: 1, y: -60, z: 0 }] })
  const refused = await actions.breakBlockAt(protectedBlock.controller, { x: 1, y: -60, z: 0 })
  assert.equal(refused.error, 'BLOCK_PROTECTED')
  assert.equal(protectedBlock.calls.dig.length, 0)

  const nearPlayer = stub({
    blocks: [{ name: 'stone', x: 1, y: -60, z: 0 }],
    entities: { 9: { id: 9, name: 'player', type: 'player', position: new Vec3(2, -60, 0) } },
    players: { Alice: { entity: { position: new Vec3(2, -60, 0) } } }
  })
  const guarded = await actions.breakBlockAt(nearPlayer.controller, { x: 1, y: -60, z: 0 })
  assert.equal(guarded.error, 'BLOCK_NEAR_PLAYER')
  assert.equal(nearPlayer.calls.dig.length, 0)

  const ok = stub({ blocks: [{ name: 'stone', x: 1, y: -60, z: 0 }] })
  const broke = await actions.breakBlockAt(ok.controller, { x: 1, y: -60, z: 0 })
  assert.equal(broke.ok, true)
  assert.deepEqual(ok.calls.dig, ['stone'])
})

test('placing needs a block in hand and a support', async () => {
  const holdingTool = stub({ items: [item('iron_pickaxe', 1)], blocks: [{ name: 'stone', x: 0, y: -61, z: 0 }] })
  const notABlock = await actions.placeBlockAt(holdingTool.controller, { x: 1, y: -60, z: 0 })
  assert.equal(notABlock.error, 'NOT_A_BLOCK')

  const occupied = stub({ items: [item('stone', 5)], blocks: [{ name: 'dirt', x: 1, y: -60, z: 0 }] })
  const busy = await actions.placeBlockAt(occupied.controller, { x: 1, y: -60, z: 0 })
  assert.equal(busy.error, 'BLOCK_OCCUPIED')

  const supported = stub({ items: [item('stone', 5)], blocks: [{ name: 'dirt', x: 0, y: -61, z: 0 }] })
  const placed = await actions.placeBlockAt(supported.controller, { x: 0, y: -60, z: 0 })
  assert.equal(placed.ok, true)
  assert.equal(supported.calls.place.length, 1)
})

test('attacking never targets players and reports an empty field', async () => {
  const onlyPlayer = stub()
  assert.equal((await actions.attackNearest(onlyPlayer.controller, { radius: 6 })).error, 'NO_TARGET')

  const withZombie = stub({
    entities: { 7: { id: 7, name: 'zombie', type: 'mob', position: new Vec3(1, -60, 0) } }
  })
  const hit = await actions.attackNearest(withZombie.controller, { radius: 6 })
  assert.equal(hit.ok, true)
  assert.deepEqual(withZombie.calls.attack, ['zombie'])
})

test('respawn is skipped while alive and used when dead', async () => {
  const alive = stub()
  assert.equal((await actions.respawnBot(alive.controller)).skipped, true)
  assert.equal(alive.calls.respawn, 0)

  const dead = stub()
  dead.bot.health = 0
  const respawned = await actions.respawnBot(dead.controller)
  assert.equal(respawned.respawned, true)
  assert.equal(dead.calls.respawn, 1)
})

test('crafting explains a missing recipe or table', async () => {
  const { controller } = stub({ target: null })
  const unknown = await actions.craftItem(controller, { item: 'diamond_block' })
  assert.equal(unknown.error, 'ITEM_NOT_FOUND')

  // The stub has no recipes at all, so discovery must report NO_RECIPE.
  const noRecipe = await actions.craftItem(controller, { item: 'stick' })
  assert.equal(noRecipe.error, 'NO_RECIPE', JSON.stringify(noRecipe))
})

test('containers report when none is nearby', async () => {
  const { controller } = stub()
  const result = await actions.containerAction(controller, { action: 'list' })
  assert.equal(result.error, 'NO_CONTAINER')
})

// ---- autopilot -----------------------------------------------------------

test('autopilot defaults are conservative', () => {
  assert.equal(AUTOPILOT_DEFAULTS.enabled, true)
  assert.equal(AUTOPILOT_DEFAULTS.defend, true)
  assert.equal(AUTOPILOT_DEFAULTS.followOwner, false)
  assert.equal(AUTOPILOT_DEFAULTS.fleeHealth, 6)
})

test('autopilot merges and clamps switches', () => {
  const { controller } = stub()
  const pilot = new Autopilot({ botController: controller, config: normalizeConfig({}), events: new EventLog(20) })
  const snapshot = pilot.setOptions({ defend: false, eatThreshold: 99, fleeHealth: 0, bogus: true })
  assert.equal(snapshot.defend, false)
  assert.equal(snapshot.eatThreshold, 20)
  assert.equal(snapshot.fleeHealth, 1)
  assert.equal('bogus' in snapshot, false)
})

test('autopilot eats when hunger drops', async () => {
  const { bot, controller, calls } = stub({ items: [item('bread', 4)], food: 10 })
  const pilot = new Autopilot({ botController: controller, config: normalizeConfig({}), events: new EventLog(50) })
  pilot.start()
  try {
    for (let i = 0; i < 10 && calls.consume === 0; i++) await sleep(150)
    assert.equal(calls.consume, 1, 'autopilot should eat at hunger 10')
    assert.match(pilot.snapshot().lastAction.message, /吃了/)
  } finally {
    pilot.stop()
  }
})

test('autopilot retaliates after being hurt', async () => {
  const { bot, controller, calls } = stub({
    entities: { 7: { id: 7, name: 'zombie', type: 'mob', position: new Vec3(1, -60, 0) } }
  })
  const pilot = new Autopilot({ botController: controller, config: normalizeConfig({}), events: new EventLog(50) })
  pilot.start()
  try {
    // Simulate damage: the listener is attached on start.
    pilot.lastThreatAt = Date.now()
    for (let i = 0; i < 10 && calls.attack.length === 0; i++) await sleep(150)
    assert.deepEqual(calls.attack, ['zombie'])
  } finally {
    pilot.stop()
  }
})

test('autopilot does nothing while a behaviour owns the loop', async () => {
  const { bot, controller, calls } = stub({ items: [item('bread', 4)], food: 5 })
  controller.behaviors = { snapshot: () => ({ active: true }) }
  const pilot = new Autopilot({ botController: controller, config: normalizeConfig({}), events: new EventLog(50) })
  pilot.start()
  try {
    await sleep(700)
    assert.equal(calls.consume, 0)
    assert.equal(calls.attack.length, 0)
  } finally {
    pilot.stop()
  }
})

test('autopilot respawns after death even during a behaviour', async () => {
  const { bot, controller, calls } = stub()
  controller.behaviors = { snapshot: () => ({ active: true }) }
  bot.health = 0
  const pilot = new Autopilot({ botController: controller, config: normalizeConfig({}), events: new EventLog(50) })
  pilot.start()
  try {
    for (let i = 0; i < 10 && calls.respawn === 0; i++) await sleep(150)
    assert.equal(calls.respawn, 1)
  } finally {
    pilot.stop()
  }
})

test('autopilot stays quiet when disabled', async () => {
  const { bot, controller, calls } = stub({ items: [item('bread', 4)], food: 5 })
  const pilot = new Autopilot({ botController: controller, config: normalizeConfig({}), events: new EventLog(50) })
  pilot.setOptions({ enabled: false })
  pilot.start()
  try {
    await sleep(700)
    assert.equal(calls.consume, 0)
  } finally {
    pilot.stop()
  }
})




