import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Vec3 } from 'vec3'

import { BuildTask, planBuild, resolveOrigin } from '../lib/builder.js'
import { EventLog } from '../lib/events.js'
import { parseBuildingSpec, toSchematic } from '../lib/schematic-spec.js'
import { createFakeBot } from './helpers/fake-bot.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE = path.join(HERE, '..', 'examples', 'small_house.json')

async function houseSchematic() {
  const spec = JSON.parse(await readFile(EXAMPLE, 'utf8'))
  return toSchematic(parseBuildingSpec(spec), '1.20.4').schematic
}

const ORIGIN = new Vec3(10, 64, 10)
const GEAR = { oak_planks: 200, oak_log: 10, glass: 10 }

test('preflight reports missing materials instead of mining them', async () => {
  const schematic = await houseSchematic()
  const { bot } = createFakeBot({ origin: ORIGIN, size: { x: 7, y: 3, z: 7 } })
  const plan = await planBuild({ bot, schematic, origin: ORIGIN, options: { rotation: 0 } })
  assert.equal(plan.ok, false)
  assert.equal(plan.error, 'MISSING_MATERIALS')
  assert.equal(plan.missing.oak_planks.need, 116)
  assert.equal(plan.missing.oak_planks.have, 0)
  assert.equal(plan.missing.glass.need, 3)
})

test('preflight refuses an occupied footprint by default, and can skip it', async () => {
  const schematic = await houseSchematic()
  const fake = createFakeBot({ origin: ORIGIN, size: { x: 7, y: 3, z: 7 }, gear: GEAR })
  fake.setBlock(ORIGIN.x, ORIGIN.y, ORIGIN.z, 'stone')

  const abort = await planBuild({ bot: fake.bot, schematic, origin: ORIGIN, options: { rotation: 0 } })
  assert.equal(abort.ok, false)
  assert.equal(abort.error, 'BUILD_AREA_OCCUPIED')
  assert.equal(abort.occupiedCount, 1)

  const skip = await planBuild({ bot: fake.bot, schematic, origin: ORIGIN, options: { rotation: 0, onOccupied: 'skip' } })
  assert.equal(skip.ok, true)
  assert.equal(skip.occupiedCount, 1)
  assert.equal(skip.targetCount, 120)
})

test('a full build places every block and verifies the world', async () => {
  const schematic = await houseSchematic()
  const fake = createFakeBot({ origin: ORIGIN, size: { x: 7, y: 3, z: 7 }, gear: GEAR })
  const plan = await planBuild({
    bot: fake.bot,
    schematic,
    origin: ORIGIN,
    options: { rotation: 0, buildSpeed: 500, reach: 4.5, maxBuildBlocks: 1000 },
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.targetCount, 121)
  assert.equal(plan.required.oak_planks, 116)

  const events = new EventLog(50)
  const task = new BuildTask({
    bot: fake.bot,
    schematic,
    origin: ORIGIN,
    options: { rotation: 0, buildSpeed: 500, reach: 4.5 },
    events,
  })
  const result = await task.start(plan)
  assert.equal(result.status, 'done')
  assert.equal(result.placed, 121)
  assert.equal(result.failed, 0)
  assert.equal(result.skipped, 0)

  // Floor, wall, window, door gap and skylight all match the projection.
  assert.equal(fake.getBlock(ORIGIN.x, ORIGIN.y, ORIGIN.z).name, 'oak_planks')
  assert.equal(fake.getBlock(ORIGIN.x, ORIGIN.y + 1, ORIGIN.z).name, 'oak_log')
  assert.equal(fake.getBlock(ORIGIN.x + 2, ORIGIN.y + 1, ORIGIN.z).name, 'glass')
  assert.equal(fake.getBlock(ORIGIN.x + 2, ORIGIN.y + 1, ORIGIN.z + 6), null)
  assert.equal(fake.getBlock(ORIGIN.x + 3, ORIGIN.y + 2, ORIGIN.z + 3).name, 'glass')
  assert.ok(events.items.some((event) => event.type === 'build_start'))
  assert.ok(events.items.some((event) => event.type === 'build_done'))
})

test('cancel stops the build between placements', async () => {
  const schematic = await houseSchematic()
  const fake = createFakeBot({ origin: ORIGIN, size: { x: 7, y: 3, z: 7 }, gear: GEAR })
  const plan = await planBuild({ bot: fake.bot, schematic, origin: ORIGIN, options: { rotation: 0, reach: 4.5 } })
  const task = new BuildTask({
    bot: fake.bot,
    schematic,
    origin: ORIGIN,
    options: { rotation: 0, buildSpeed: 100, reach: 4.5 },
    events: new EventLog(20),
  })
  const running = task.start(plan)
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(task.cancel('test'), true)
  const result = await running
  assert.equal(result.status, 'cancelled')
  assert.ok(result.placed < 121)
})

test('resolveOrigin uses the player front direction or an explicit position', () => {
  const fake = createFakeBot({ origin: new Vec3(0, 64, 0), size: { x: 1, y: 1, z: 1 } })
  fake.bot.entity.yaw = 0
  fake.bot.entity.position = new Vec3(0, 64, 0)
  assert.deepEqual(resolveOrigin(fake.bot, null, { distance: 4 }), new Vec3(0, 64, 4))
  assert.deepEqual(resolveOrigin(fake.bot, { x: 1.9, y: 70.2, z: -3.4 }), new Vec3(1, 70, -4))
})
