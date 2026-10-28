import assert from 'node:assert/strict'
import test from 'node:test'

import minecraftData from 'minecraft-data'
import { Vec3 } from 'vec3'

import { BuildTask, planBuild, resolveScaffold } from '../lib/builder.js'
import {
  isProtocolVersionError,
  latestSupportedVersion,
  normalizeSupportedVersions,
  parseMcVersion,
  supportsTickEnd,
  versionAtLeast,
} from '../lib/bot.js'
import { EventLog } from '../lib/events.js'
import { publicPlan } from '../lib/mode.js'
import { parseBuildingSpec, toSchematic } from '../lib/schematic-spec.js'
import { createFakeBot } from './helpers/fake-bot.mjs'

const ORIGIN = new Vec3(10, 64, 10)

function tinySchematic() {
  const spec = parseBuildingSpec({
    name: 'one_block',
    size: { x: 1, y: 1, z: 1 },
    palette: { A: 'stone', '.': 'air' },
    layers: [{ y: 0, rows: ['A'] }],
  })
  return toSchematic(spec, '1.20.4').schematic
}

/** A pathfinder that fails until tower mode is enabled. */
function installStuckPathfinder(fake) {
  fake.bot.registry = minecraftData('1.20.4')
  fake.bot.pathfinder = {
    movements: undefined,
    goals: null,
    setMovements(movements) {
      this.movements = movements
    },
    async goto() {
      if (!this.movements?.allow1by1towers) throw new Error('No path to the goal!')
    },
    stop() {},
    isMoving() {
      return false
    },
  }
}

test('publicPlan output is lossless JSON (no Vec3 leaks into tool results)', () => {
  const plan = {
    ok: false,
    error: 'MISSING_MATERIALS',
    origin: new Vec3(1, 2, 3),
    size: new Vec3(3, 1, 3),
    occupied: [{ name: 'stone', existing: 'dirt', pos: new Vec3(4, 5, 6) }],
    targets: [{ pos: new Vec3(7, 8, 9), name: 'stone' }],
    _internal: { Block: class {} },
    missing: { stone: { need: 1, have: 0 } },
  }
  const out = publicPlan(plan)
  assert.doesNotThrow(() => JSON.stringify(out))
  assert.deepEqual(out.origin, { x: 1, y: 2, z: 3 })
  assert.deepEqual(out.size, { x: 3, y: 1, z: 3 })
  assert.deepEqual(out.occupied, [{ name: 'stone', existing: 'dirt', pos: { x: 4, y: 5, z: 6 } }])
  assert.equal('targets' in out, false)
  assert.equal('_internal' in out, false)
})

test('Minecraft version comparison handles 1.21.x and the 26.x scheme', () => {
  assert.deepEqual(parseMcVersion('1.21.2-pre1'), [1, 21, 2])
  assert.deepEqual(parseMcVersion('26.3'), [26, 3, 0])
  assert.equal(versionAtLeast('1.21.11', '1.21.2'), true)
  assert.equal(versionAtLeast('26.1', '1.21.2'), true)
  assert.equal(versionAtLeast('1.20.4', '1.21.2'), false)
  // tick_end exists since 1.21.2 and is required by 26.3 servers.
  assert.equal(supportsTickEnd('1.21.1'), false)
  assert.equal(supportsTickEnd('1.21.2'), true)
  assert.equal(supportsTickEnd('26.1'), true)
  assert.equal(supportsTickEnd('26.3'), true)
  // minecraft-protocol exposes an array, not an object; do not treat indices
  // as versions (this rejected explicit 1.20.4 in an early draft).
  assert.deepEqual(normalizeSupportedVersions(['1.7', '1.20.4', '26.1', 'junk']), ['1.7', '1.20.4', '26.1'])
  assert.equal(latestSupportedVersion(['1.7', '1.20.4', '26.1']), '26.1')
  assert.equal(latestSupportedVersion(['1.21.11', '1.21.2']), '1.21.11')
  assert.equal(isProtocolVersionError(new Error('MC_VERSION_UNSUPPORTED: 26.3')), true)
  assert.equal(isProtocolVersionError(new Error('unsupported protocol version 777')), true)
  assert.equal(isProtocolVersionError(new Error('connect ECONNREFUSED 127.0.0.1:25565')), false)
})

test('scaffold resolver prefers non-required blocks and reports missing material', () => {
  const mcData = minecraftData('1.20.4')
  const create = (gear, gameMode = 'survival', allowCreativeFill = false) => {
    const fake = createFakeBot({ origin: ORIGIN, size: { x: 1, y: 1, z: 1 }, gear })
    fake.bot.game.gameMode = gameMode
    return fake.bot
  }

  const dirtOnly = resolveScaffold({
    bot: create({ dirt: 5 }),
    mcData,
    required: new Map(),
    options: { allowScaffold: true, scaffoldBlocks: ['dirt', 'cobblestone'] },
  })
  assert.equal(dirtOnly.enabled, true)
  assert.equal(dirtOnly.name, 'dirt')
  assert.equal(dirtOnly.available, 5)

  const preferFree = resolveScaffold({
    bot: create({ dirt: 2, oak_planks: 100 }),
    mcData,
    required: new Map([['oak_planks', 100]]),
    options: { allowScaffold: true, scaffoldBlocks: ['dirt', 'oak_planks'] },
  })
  assert.equal(preferFree.name, 'dirt')

  const creative = resolveScaffold({
    bot: create({}, 'creative', true),
    mcData,
    required: new Map(),
    options: { allowScaffold: true, scaffoldBlocks: ['dirt'], allowCreativeFill: true, scaffoldBudget: 8 },
  })
  assert.equal(creative.enabled, true)
  assert.equal(creative.creativeFill, true)
  assert.equal(creative.budget, 8)

  const none = resolveScaffold({
    bot: create({}),
    mcData,
    required: new Map(),
    options: { allowScaffold: true, scaffoldBlocks: ['dirt'] },
  })
  assert.equal(none.enabled, false)
  assert.equal(none.reason, 'NO_SCAFFOLD_MATERIAL')

  const disabled = resolveScaffold({
    bot: create({ dirt: 5 }),
    mcData,
    required: new Map(),
    options: { allowScaffold: false },
  })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.reason, 'DISABLED')
})

test('a stuck builder enables tower/bridge moves and restores passive moves afterwards', async () => {
  const schematic = tinySchematic()
  const fake = createFakeBot({ origin: ORIGIN, size: { x: 1, y: 1, z: 1 }, gear: { stone: 4, dirt: 6 } })
  installStuckPathfinder(fake)
  const plan = await planBuild({
    bot: fake.bot,
    schematic,
    origin: ORIGIN,
    options: { allowScaffold: true, scaffoldBlocks: ['dirt'], scaffoldBudget: 4, buildSpeed: 500 },
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.scaffold.enabled, true)
  assert.equal(plan.scaffold.name, 'dirt')

  const events = new EventLog(50)
  const task = new BuildTask({
    bot: fake.bot,
    schematic,
    origin: ORIGIN,
    options: { allowScaffold: true, scaffoldBlocks: ['dirt'], scaffoldBudget: 4, buildSpeed: 500 },
    events,
  })
  const result = await task.start(plan)
  assert.equal(result.status, 'done')
  assert.equal(result.placed, 1)
  assert.equal(events.items.some((event) => event.type === 'build_scaffold' && event.message.includes('启用垫脚')), true)
  // Passive following must not inherit tower mode.
  assert.equal(fake.bot.pathfinder.movements.allow1by1towers, false)
  assert.equal(fake.bot.pathfinder.movements.scafoldingBlocks.length, 0)
})

test('creative build fills a scaffold stack before relying on it', async () => {
  const schematic = tinySchematic()
  const fake = createFakeBot({ origin: ORIGIN, size: { x: 1, y: 1, z: 1 }, gear: { stone: 4 } })
  fake.bot.game.gameMode = 'creative'
  installStuckPathfinder(fake)
  const plan = await planBuild({
    bot: fake.bot,
    schematic,
    origin: ORIGIN,
    options: {
      allowScaffold: true,
      scaffoldBlocks: ['dirt'],
      scaffoldBudget: 4,
      allowCreativeFill: true,
      buildSpeed: 500,
    },
  })
  assert.equal(plan.scaffold.creativeFill, true)

  const task = new BuildTask({
    bot: fake.bot,
    schematic,
    origin: ORIGIN,
    options: {
      allowScaffold: true,
      scaffoldBlocks: ['dirt'],
      scaffoldBudget: 4,
      allowCreativeFill: true,
      buildSpeed: 500,
    },
    events: new EventLog(20),
  })
  const result = await task.start(plan)
  assert.equal(result.status, 'done')
  assert.equal(fake.inventory.some((item) => item.name === 'dirt' && item.count === 4), true)
})
