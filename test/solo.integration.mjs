#!/usr/bin/env node
/**
 * Solo plan end-to-end: the bot starts with an empty inventory and has to reach
 * stone tools + a furnace on its own, one verified step at a time.
 *
 * The world is prepared over RCON (a small tree and a stone patch) because the
 * test server is flat; everything after that is the bot's own work.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { RCON_PORT, startServer } from '../scripts/start-test-server.mjs'
import { RCON_PASSWORD, rconCommand } from '../scripts/rcon.mjs'

const log = (...args) => console.log('[solo-e2e]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (command) => rconCommand({ port: RCON_PORT, password: RCON_PASSWORD, command, timeoutMs: 8_000 })

async function until (fn, { timeoutMs = 60_000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

async function main () {
  const server = await startServer({ resetWorld: true })
  if (server.external) throw new Error('MC_TEST_SERVER_RUNNING: 先停掉测试端口上的服务器。')
  log(`server on ${server.port}`)

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-solo-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: server.port,
    username: 'SoloBot',
    version: '1.20.4',
    autoConnect: false,
    autoFollow: false,
    autopilot: { enabled: false },
    behaviors: { explore: false, woodcut: true, mine: true, fight: false }
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    const solo = tools.get('mc_solo')
    assert.ok(solo, 'mc_solo must be registered on enable')
    // Build the workshop *before* the bot connects, so the first chunks it
    // receives already contain the tree and the stone (blocks placed after the
    // chunks load are not always visible to bot.findBlocks).
    const wx = 0
    const wy = -60
    const wz = 0
    for (const [dx, dz] of [[2, 0], [3, 1], [4, -1]]) {
      for (const dy of [0, 1, 2]) await rcon(`setblock ${wx + dx} ${wy + dy} ${wz + dz} minecraft:oak_log`)
    }
    for (const [dx, dz] of [[-2, 0], [-2, 1], [-2, -1], [0, 2], [1, 2], [-1, 2], [0, -2], [1, -2], [-1, -2], [2, 2], [-2, 2], [2, -2]]) {
      await rcon(`setblock ${wx + dx} ${wy} ${wz + dz} minecraft:stone`)
    }
    log(`workshop placed at ${wx},${wy},${wz}`)

    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    const bot = companion.bot.bot
    await rcon('gamemode survival SoloBot')
    await rcon('clear SoloBot')
    await rcon(`tp SoloBot ${wx} ${wy} ${wz}`)
    await sleep(3_000)

    const base = { x: wx, y: wy, z: wz }
    const treeBlock = bot.blockAt(new Vec3(wx + 2, wy + 1, wz))
    const stoneSeen = bot.findBlocks({ matching: (block) => block?.name === 'stone', maxDistance: 32, count: 32 }).length
    log(`workshop ready: tree=${treeBlock?.name ?? 'none'} visibleStone=${stoneSeen}`)
    assert.equal(treeBlock?.name, 'oak_log', 'the tree should be loaded')
    assert.ok(stoneSeen > 0, 'the stone patch should be loaded')

    const started = await solo.execute({ action: 'start', plan: 'bootstrap' }, exec)
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.running, true)
    log(`plan started with ${started.total} steps`)

    const finished = await until(
      () => {
        const state = companion.solo.snapshot()
        return state.running ? false : state
      },
      { timeoutMs: 300_000, intervalMs: 1_000, label: 'bootstrap plan to finish' }
    )
    log(`steps: ${finished.steps.map((step) => `${step.id}:${step.status}`).join(' ')}`)
    assert.equal(finished.error, null, `plan failed: ${finished.error}`)
    assert.ok(finished.steps.every((step) => step.status === 'done'), JSON.stringify(finished.steps))

    const inventory = await tools.get('mc_inventory').execute({ action: 'list' }, exec)
    assert.ok(inventory.items.some((item) => item.name === 'stone_pickaxe'), 'stone pickaxe should be crafted')
    assert.ok(inventory.items.some((item) => item.name === 'furnace'), 'furnace should be crafted')
    log('PASS solo bootstrap: logs -> table -> wooden pickaxe -> stone -> stone pickaxe -> furnace')
    log(`total ${(finished.elapsedMs / 1000).toFixed(1)}s`)

    // The status tool has to expose the same run without restarting it.
    const status = await solo.execute({ action: 'status' }, exec)
    assert.equal(status.running, false)
    assert.equal(status.total, finished.total)

    console.log('\n=== SOLO E2E PASS ===')
    process.exit(0)
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: 'solo e2e done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== SOLO E2E FAIL ===')
  console.error(error)
  process.exit(1)
})








