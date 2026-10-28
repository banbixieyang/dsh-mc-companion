#!/usr/bin/env node
/**
 * Navigation (`mc_goto`) and block interaction (`mc_use_block`).
 *
 * Stub-bot tests: what matters here is the *decision* logic — refusing an
 * impossible trip, distinguishing "stuck" from "timeout", and never treating a
 * container as something to poke. The real walking/sleeping is covered by
 * test/behaviors.integration.mjs against a live Paper server.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { gotoPosition } from '../lib/navigation.js'
import { activateBlockAt, isActivatable, isBed, isContainer, sleepInBed } from '../lib/interact.js'
import { normalizeConfig, DEFAULTS } from '../lib/config.js'

/** Bot stub whose position is driven by a callback on every read. */
function stubBot ({ position = new Vec3(0, -60, 0), step = null, sleepImpl = null, blocks = [], moving = true } = {}) {
  const state = { position: position.clone(), goal: null }
  const bot = {
    isSleeping: false,
    game: { gameMode: 'creative' },
    entity: {
      get position () {
        if (step) state.position = step(state.position)
        return state.position
      }
    },
    pathfinder: {
      setGoal (goal) {
        state.goal = goal
      },
      isMoving: () => moving,
      async goto () {}
    },
    findBlocks ({ matching, maxDistance }) {
      return blocks
        .filter((entry) => matching({ name: entry.name }))
        .map((entry) => new Vec3(entry.x, entry.y, entry.z))
        .filter((p) => p.distanceTo(state.position) <= maxDistance)
    },
    blockAt (position) {
      const entry = blocks.find((e) => e.x === position.x && e.y === position.y && e.z === position.z)
      return entry ? { name: entry.name, position: new Vec3(entry.x, entry.y, entry.z) } : null
    },
    async sleep (bed) {
      if (sleepImpl) return sleepImpl(bed, bot)
      bot.isSleeping = true
    },
    async activateBlock () {},
    on () {},
    removeListener () {}
  }
  return {
    botController: {
      bot,
      config: normalizeConfig({}),
      pathfinder: {
        goals: {
          GoalNear: class {
            constructor (x, y, z, range) {
              Object.assign(this, { x, y, z, range })
            }
          },
          GoalXZ: class {
            constructor (x, z) {
              Object.assign(this, { x, z })
            }
          }
        }
      }
    },
    state
  }
}

test('applies goto config defaults', () => {
  assert.equal(DEFAULTS.gotoMaxDistance, 128)
  assert.equal(DEFAULTS.gotoTimeoutMs, 60_000)
})

test('rejects invalid coordinates instead of walking to NaN', async () => {
  const { botController } = stubBot()
  await assert.rejects(() => gotoPosition(botController, { x: 'a', y: 2, z: 3 }), /MC_GOTO_INVALID_ARGS/)
})

test('refuses a trip longer than gotoMaxDistance', async () => {
  const { botController } = stubBot()
  const result = await gotoPosition(botController, { x: 500, y: -60, z: 500, timeoutMs: 2_000 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'MC_GOTO_TOO_FAR')
  assert.match(result.message, /分段/)
})

test('reports "already there" without touching the pathfinder', async () => {
  const { botController, state } = stubBot()
  const result = await gotoPosition(botController, { x: 0, y: -60, z: 0 })
  assert.equal(result.ok, true)
  assert.equal(result.alreadyThere, true)
  assert.equal(result.elapsedMs, 0)
  assert.equal(state.goal, null)
})

test('walks and reports arrival', async () => {
  // Move 2 blocks per read so a 5 block trip finishes quickly.
  const { botController, state } = stubBot({
    step: (position) => {
      const next = position.clone()
      const dz = 5 - position.z
      next.z = position.z + Math.sign(dz) * Math.min(2, Math.abs(dz))
      return next
    }
  })
  const result = await gotoPosition(botController, { x: 0, y: -60, z: 5, tolerance: 1 })
  assert.equal(result.ok, true)
  assert.equal(result.to.z, 5)
  assert.equal(state.goal, null, 'goal must be cleared after arrival')
})

test('a bot that never improves is reported as stuck, not as a timeout', async () => {
  const { botController } = stubBot({ moving: true })
  const result = await gotoPosition(botController, { x: 40, y: -60, z: 40, timeoutMs: 30_000 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'MC_PATH_STUCK')
  assert.match(result.message, /地形可能过不去/)
  assert.equal(result.to.x, 40)
})

test('a short budget surfaces as a timeout', async () => {
  const { botController } = stubBot({ moving: false })
  const result = await gotoPosition(botController, { x: 60, y: -60, z: 0, timeoutMs: 1_000 })
  assert.equal(result.ok, false)
  // Stuck detection is 5s; a 1s budget must win first.
  assert.equal(result.error, 'MC_GOTO_TIMEOUT')
})

test('block classification', () => {
  assert.equal(isBed('red_bed'), true)
  assert.equal(isBed('oak_planks'), false)
  assert.equal(isActivatable('oak_button'), true)
  assert.equal(isActivatable('lever'), true)
  assert.equal(isActivatable('oak_door'), true)
  assert.equal(isActivatable('stone'), false)
  assert.equal(isContainer('chest'), true)
  assert.equal(isContainer('white_shulker_box'), true)
  assert.equal(isContainer('oak_planks'), false)
})

test('sleep without a bed nearby reports BED_NOT_FOUND', async () => {
  const { botController } = stubBot()
  const result = await sleepInBed(botController, {})
  assert.equal(result.ok, false)
  assert.equal(result.error, 'BED_NOT_FOUND')
})

test('sleeping in a found bed succeeds and echoes the bed', async () => {
  const { botController } = stubBot({ blocks: [{ name: 'red_bed', x: 1, y: -60, z: 0 }] })
  const result = await sleepInBed(botController, { radius: 6 })
  assert.equal(result.ok, true)
  assert.equal(result.slept, true)
  assert.equal(result.bed.name, 'red_bed')
  assert.deepEqual(result.bed.position, { x: 1, y: -60, z: 0 })
})

test('daytime refusal is passed through with the server reason', async () => {
  const { botController } = stubBot({
    blocks: [{ name: 'red_bed', x: 1, y: -60, z: 0 }],
    sleepImpl: async (bed, bot) => {
      // mineflayer surfaces the server text; the tool must keep it.
      throw new Error('You can only sleep at night or during a thunderstorm')
    }
  })
  const result = await sleepInBed(botController, { radius: 6 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'SLEEP_FAILED')
  assert.match(result.message, /night/)
})

test('explicit coordinates must point at a bed', async () => {
  const { botController } = stubBot({ blocks: [{ name: 'oak_planks', x: 2, y: -60, z: 2 }] })
  const result = await sleepInBed(botController, { x: 2, y: -60, z: 2 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'BED_NOT_FOUND')
})

test('containers are never activated', async () => {
  const { botController } = stubBot({ blocks: [{ name: 'chest', x: 1, y: -60, z: 0 }] })
  const result = await activateBlockAt(botController, { x: 1, y: -60, z: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'BLOCK_NOT_ALLOWED')
  assert.match(result.message, /容器/)
})

test('non-whitelisted blocks are refused, whitelisted ones are used', async () => {
  const blocked = stubBot({ blocks: [{ name: 'diamond_block', x: 1, y: -60, z: 0 }] })
  const refused = await activateBlockAt(blocked.botController, { x: 1, y: -60, z: 0 })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'BLOCK_NOT_ALLOWED')

  const allowed = stubBot({ blocks: [{ name: 'oak_button', x: 1, y: -60, z: 0 }] })
  const used = await activateBlockAt(allowed.botController, { x: 1, y: -60, z: 0 })
  assert.equal(used.ok, true)
  assert.equal(used.block.name, 'oak_button')
})
