#!/usr/bin/env node
/**
 * Behaviour layer: authorization, safety rails and target selection.
 *
 * These run against a stub bot — no server, no network. The real dig/attack
 * paths are covered by test/behaviors.integration.mjs; what is asserted here is
 * the part that must never be wrong: what the bot is *allowed* to do, when it
 * stops, and which blocks it will pick.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { normalizeConfig } from '../lib/config.js'
import { EventLog } from '../lib/events.js'
import { BehaviorRunner, BEHAVIORS } from '../lib/behaviors/runner.js'
import { findDigTarget } from '../lib/behaviors/helpers.js'
import { isLogBlock, isProtectedBlock, nearOtherPlayer, DEFAULT_FIGHT_TARGETS } from '../lib/behaviors/targets.js'

/** Minimal mineflayer stand-in: only what the behaviours touch. */
function stubBot ({ blocks = [], health = 20, players = {} } = {}) {
  const world = blocks.map((entry) => ({ ...entry }))
  const asBlock = (entry) => ({ name: entry.name, position: new Vec3(entry.x, entry.y, entry.z) })
  const bot = {
    entity: { position: new Vec3(0, -59, 0), id: 1 },
    health,
    game: { gameMode: 'creative' },
    players,
    entities: {},
    heldItem: { name: 'diamond_pickaxe' },
    registry: {
      blocksByName: Object.fromEntries(['oak_log', 'stone', 'iron_ore', 'oak_planks'].map((name) => [name, { name }])),
      entitiesByName: Object.fromEntries(['zombie', 'skeleton', 'chicken'].map((name) => [name, { name }]))
    },
    findBlocks ({ matching, maxDistance }) {
      return world
        .filter((entry) => entry.name !== 'air')
        .filter((entry) => matching({ name: entry.name }))
        .map((entry) => new Vec3(entry.x, entry.y, entry.z))
        .filter((position) => position.distanceTo(bot.entity.position) <= maxDistance)
    },
    blockAt (position) {
      const entry = world.find((e) => e.x === position.x && e.y === position.y && e.z === position.z)
      if (!entry || entry.name === 'air') return null
      return asBlock(entry)
    },
    canDigBlock: () => true,
    // the fake server always confirms: real confirmation comes from a
    // block_change packet or a drop, see lib/behaviors/helpers.js
    _serverBlockChangeAt: () => true,
    async dig (block) {
      const entry = world.find((e) => e.x === block.position.x && e.y === block.position.y && e.z === block.position.z)
      if (entry) entry.name = 'air'
    },
    stopDigging () {},
    attack () {},
    on () {},
    removeListener () {},
    pathfinder: { setGoal () {}, isMoving: () => false, async goto () {} }
  }
  return bot
}

const stubBotController = (bot) => ({
  bot,
  pathfinder: {
    goals: {
      GoalNear: class { constructor (x, y, z) { Object.assign(this, { x, y, z }) } },
      GoalXZ: class { constructor (x, z) { Object.assign(this, { x, z }) } },
      GoalFollow: class { constructor (entity) { this.entity = entity } }
    }
  }
})

const configWith = (behaviors, extra = {}) => normalizeConfig({ behaviors, ...extra })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('every behaviour declares its contract', () => {
  for (const [mode, behavior] of BEHAVIORS) {
    assert.equal(behavior.mode, mode)
    assert.equal(typeof behavior.label, 'string')
    assert.equal(typeof behavior.prepare, 'function')
  }
  assert.deepEqual([...BEHAVIORS.keys()].sort(), ['explore', 'fight', 'mine', 'woodcut'])
})

test('a mode that is not authorised is refused with a usable hint', () => {
  const runner = new BehaviorRunner({
    bot: stubBotController(stubBot()),
    config: configWith({ woodcut: true }),
    events: new EventLog(50)
  })
  assert.throws(() => runner.start('fight', {}), /MC_BEHAVIOR_NOT_ALLOWED: 行为 fight 未在配置中开启/)
  assert.throws(() => runner.start('fight', {}), /当前已开启：woodcut/)
  assert.throws(() => runner.start('mine', {}), /MC_BEHAVIOR_NOT_ALLOWED/)
  // and the allowed one works
  const started = runner.start('woodcut', { amount: 1 })
  assert.equal(started.active, true)
  runner.dispose()
})

test('unknown modes and offline bots are rejected', () => {
  const runner = new BehaviorRunner({ bot: stubBotController(stubBot()), config: configWith({ woodcut: true }), events: new EventLog(50) })
  assert.throws(() => runner.start('dig-everything', {}), /MC_BEHAVIOR_UNKNOWN/)
  const offline = new BehaviorRunner({ bot: { bot: null }, config: configWith({ woodcut: true }), events: new EventLog(50) })
  assert.throws(() => offline.start('woodcut', {}), /MC_BOT_OFFLINE/)
})

test('tree, ore and protection rules', () => {
  assert.equal(isLogBlock('oak_log'), true)
  assert.equal(isLogBlock('stripped_spruce_log'), true)
  assert.equal(isLogBlock('crimson_stem'), true)
  assert.equal(isLogBlock('oak_planks'), false)
  assert.equal(isLogBlock('oak_leaves'), false)

  for (const name of ['chest', 'trapped_chest', 'ender_chest', 'white_shulker_box', 'red_bed', 'oak_sign', 'spawner', 'beacon', 'command_block', 'diamond_ore']) {
    assert.equal(isProtectedBlock(name), name === 'diamond_ore' ? false : true, name)
  }
  assert.equal(isProtectedBlock('stone'), false)
  assert.equal(isProtectedBlock('oak_planks', ['oak_planks']), true, 'config blacklist must win')

  const bot = stubBot({
    players: { Someone: { entity: { position: new Vec3(4, -59, 0) } } }
  })
  assert.equal(nearOtherPlayer(bot, new Vec3(5, -59, 0), 3), true)
  assert.equal(nearOtherPlayer(bot, new Vec3(20, -59, 0), 3), false)
})

test('target finder skips protected blocks and unreachable ones', () => {
  const bot = stubBot({
    blocks: [
      { name: 'oak_log', x: 6, y: -59, z: 0 },
      { name: 'chest', x: 2, y: -59, z: 0 }
    ]
  })
  const found = findDigTarget(bot, {
    matcher: (name) => name === 'oak_log' || name === 'chest',
    radius: 10,
    blacklist: [],
    protectPlayers: true,
    protectDistance: 3,
    avoid: new Set()
  })
  assert.equal(found.block.name, 'oak_log', 'the chest must be filtered out')
})

test('woodcutting stops by itself when the target amount is reached', async () => {
  const bot = stubBot({
    blocks: [
      { name: 'oak_log', x: 2, y: -59, z: 0 },
      { name: 'oak_log', x: 3, y: -59, z: 0 }
    ]
  })
  const events = new EventLog(100)
  const runner = new BehaviorRunner({ bot: stubBotController(bot), config: configWith({ woodcut: true }), events })
  runner.start('woodcut', { amount: 2, radius: 8 })

  for (let i = 0; i < 40 && runner.snapshot().active; i++) await sleep(50)
  const snapshot = runner.snapshot()
  assert.equal(snapshot.active, false, 'runner must stop on its own')
  assert.equal(runner.last.progress, 2)
  assert.equal(runner.last.reason, 'done')
  // Token economy: start + stop, plus at most one milestone event.
  const behaviorEvents = events.recent(50).filter((event) => event.type === 'behavior')
  assert.ok(behaviorEvents.length <= 3, `expected <=3 behaviour events, got ${behaviorEvents.length}`)
})

test('low health aborts the run before the next step', async () => {
  const bot = stubBot({ blocks: [{ name: 'oak_log', x: 30, y: -59, z: 0 }], health: 4 })
  const runner = new BehaviorRunner({ bot: stubBotController(bot), config: configWith({ woodcut: true }), events: new EventLog(50) })
  runner.start('woodcut', { amount: 5 })
  for (let i = 0; i < 20 && runner.snapshot().active; i++) await sleep(50)
  assert.equal(runner.snapshot().active, false)
  assert.equal(runner.last.reason, 'low_health')
})

test('stop() is idempotent and clears the active state', () => {
  const bot = stubBot({ blocks: [{ name: 'oak_log', x: 40, y: -59, z: 0 }] })
  const runner = new BehaviorRunner({ bot: stubBotController(bot), config: configWith({ woodcut: true }), events: new EventLog(50) })
  runner.start('woodcut', { amount: 3 })
  const first = runner.stop('user request')
  assert.equal(first.reason, 'user request')
  const second = runner.stop('again')
  assert.equal(second, first, 'second stop returns the same summary')
  assert.equal(runner.snapshot().active, false)
})

test('radius and amount are clamped to safe bands', () => {
  const bot = stubBot()
  const runner = new BehaviorRunner({ bot: stubBotController(bot), config: configWith({ explore: true, woodcut: true }), events: new EventLog(50) })
  const started = runner.start('woodcut', { amount: 10_000, radius: 10_000 })
  assert.equal(started.radius, 64)
  assert.equal(started.target, 128)
  runner.stop('clamp check')
})

test('default combat targets never include creepers', () => {
  assert.equal(DEFAULT_FIGHT_TARGETS.includes('creeper'), false)
  assert.equal(DEFAULT_FIGHT_TARGETS.includes('zombie'), true)
})

