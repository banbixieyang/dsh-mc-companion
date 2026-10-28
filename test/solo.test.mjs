import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SoloRunner, PLANS } from '../lib/solo.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A bot whose inventory is a plain map, plus an actions API that mutates it. */
function makeHarness ({ startItems = {}, behaviorsFail = false, craftingNoop = false } = {}) {
  const items = new Map(Object.entries(startItems))
  const bot = {
    entity: { position: { x: 0, y: -60, z: 0, floored: () => ({ x: 0, y: -60, z: 0 }) } },
    inventory: {
      items: () => [...items.entries()].flatMap(([name, count]) => (count > 0 ? [{ name, count, slot: name.length }] : []))
    },
    registry: { blocksByName: { crafting_table: { id: 1 } } },
    findBlock: () => null,
    blockAt: ({ y }) => (y < -60 ? { name: 'stone' } : { name: 'air' })
  }
  const controller = { bot, config: {} }
  const calls = { craft: [], place: [], smelt: [], equip: [] }
  const actions = {
    async equipItem (_, options) {
      calls.equip.push(options.item)
      bot.heldItem = { name: options.item, count: 1 }
      return { ok: true, item: options.item }
    },
    async craftItem (_, options) {
      calls.craft.push(options.item)
      if (!craftingNoop) items.set(options.item, (items.get(options.item) ?? 0) + (options.item === 'oak_planks' ? 4 : 1))
      return { ok: true, crafted: options.item }
    },
    async placeBlockAt (_, options) { calls.place.push(options); return { ok: true, placed: options.item } },
    async smeltItem (_, options) { calls.smelt.push(options); return { ok: true, smelted: 'iron_ingot', count: 1 } }
  }
  const behaviorCalls = []
  const last = behaviorsFail ? { reason: 'no_targets', progress: 0 } : { reason: 'done', progress: 4 }
  const behaviors = {
    start (mode, options) {
      behaviorCalls.push({ mode, options })
      if (!behaviorsFail) {
        const name = mode === 'woodcut' ? 'oak_log' : (mode === 'mine' && options?.targets?.[0] === 'iron_ore' ? 'iron_ore' : 'stone')
        items.set(name, (items.get(name) ?? 0) + (options?.amount ?? 1))
      }
      return { active: true }
    },
    stop () {},
    snapshot: () => ({ active: false }),
    last
  }
  return { bot, controller, actions, behaviors, items, calls, behaviorCalls }
}

const waitForIdle = async (runner, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (runner.running && Date.now() < deadline) await sleep(25)
  return runner.snapshot()
}

test('bootstrap plan runs every step and verifies the inventory', async () => {
  const { controller, actions, behaviors, calls } = makeHarness()
  const runner = new SoloRunner({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  const first = await runner.start('bootstrap')
  assert.equal(first.running, true)
  assert.equal(first.total, PLANS.bootstrap.length)

  const done = await waitForIdle(runner)
  assert.equal(done.running, false)
  assert.equal(done.error, null, JSON.stringify(done.error))
  assert.ok(done.steps.every((step) => step.status === 'done'), JSON.stringify(done.steps))
  assert.deepEqual(calls.craft, ['oak_planks', 'crafting_table', 'stick', 'wooden_pickaxe', 'stone_pickaxe', 'furnace'])
  assert.equal(calls.place.length, 1, 'the table has to be placed once')
  assert.ok(calls.equip.includes('wooden_pickaxe'), 'stone has to be mined with a pickaxe')
})

test('a craft that does not change the inventory fails the run', async () => {
  const { controller, actions, behaviors } = makeHarness({ craftingNoop: true })
  const runner = new SoloRunner({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  await runner.start('bootstrap')
  const done = await waitForIdle(runner)
  assert.equal(done.running, false)
  assert.match(String(done.error), /合成后背包里没有 oak_planks/)
  assert.equal(done.steps[1].status, 'failed')
  assert.equal(done.steps[2].status, 'pending', 'later steps must not run after a failure')
})

test('a behaviour that ends without progress fails the step', async () => {
  const { controller, actions, behaviors } = makeHarness({ behaviorsFail: true })
  const runner = new SoloRunner({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  await runner.start('bootstrap')
  const done = await waitForIdle(runner)
  assert.equal(done.running, false)
  assert.equal(done.steps[0].status, 'failed')
  assert.match(String(done.error), /原木不足|没有取得新的目标|行为结束但未完成/)
})

test('stop aborts the plan', async () => {
  const { controller, actions, behaviors } = makeHarness()
  const runner = new SoloRunner({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  await runner.start('speedrun')
  const stopped = runner.stop('test stop')
  assert.equal(stopped.running, false)
  await sleep(50)
  assert.equal(runner.running, false)
})

test('unknown plans and offline bots are rejected', async () => {
  const { controller, actions, behaviors } = makeHarness()
  const runner = new SoloRunner({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  await assert.rejects(() => runner.start('nope'), /SOLO_UNKNOWN_PLAN/)

  const offline = new SoloRunner({
    botController: { bot: null, config: {} },
    config: {},
    events: { push () {} },
    behaviors,
    actions
  })
  await assert.rejects(() => offline.start('bootstrap'), /MC_BOT_OFFLINE/)
})

test('speedrun plan is timed per step', async () => {
  const { controller, actions, behaviors, calls } = makeHarness()
  const runner = new SoloRunner({ botController: controller, config: {}, events: { push () {} }, behaviors, actions })
  await runner.start('speedrun')
  const done = await waitForIdle(runner)
  assert.equal(done.error, null, JSON.stringify(done.error))
  assert.ok(done.steps.every((step) => step.status === 'done' && step.ms >= 0), JSON.stringify(done.steps))
  assert.ok(calls.equip.includes('stone_pickaxe'), 'iron should be mined with the stone pickaxe')
})



