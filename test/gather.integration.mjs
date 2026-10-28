#!/usr/bin/env node
/**
 * Auto-gather build end-to-end: the bot starts with an empty inventory in
 * survival, the schematic needs planks, and the build refuses unless it goes
 * and chops the wood itself.
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

const log = (...args) => console.log('[gather-e2e]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (command) => rconCommand({ port: RCON_PORT, password: RCON_PASSWORD, command, timeoutMs: 8_000 })

async function until (fn, { timeoutMs = 90_000, intervalMs = 1_000, label = 'condition' } = {}) {
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

  const wx = 0
  const wy = -60
  const wz = 0
  for (const [dx, dz] of [[2, 0], [3, 1], [4, -1]]) {
    for (const dy of [1, 2, 3]) await rcon(`setblock ${wx + dx} ${wy + dy} ${wz + dz} minecraft:oak_log`)
  }
  log('trees planted')

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-gather-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: server.port,
    username: 'BuilderBot',
    version: '1.20.4',
    autoConnect: false,
    viewer: { enabled: false }, // the running host owns :3010
    autoFollow: false,
    allowCreativeFill: false,
    autopilot: { enabled: false },
    behaviors: { explore: false, woodcut: true, mine: true, fight: false }
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    const bot = companion.bot.bot
    await rcon('gamemode survival BuilderBot')
    await rcon('clear BuilderBot')
    await rcon(`tp BuilderBot ${wx} ${wy} ${wz}`)
    await sleep(3_000)

    // A 3x1x3 oak plank floor: 9 planks = 3 logs to chop.
    const generated = await tools.get('mc_generate_schematic').execute({
      spec: {
        name: 'gather_floor',
        size: { x: 3, y: 1, z: 3 },
        palette: { A: 'minecraft:oak_planks', '.': 'minecraft:air' },
        layers: [{ y: 0, rows: ['AAA', 'AAA', 'AAA'] }]
      },
      overwrite: true
    }, exec)
    assert.equal(generated.ok, true, JSON.stringify(generated))
    log(`schematic ${generated.name} with ${generated.solidBlocks} blocks`)

    // Dry run first: without materials it must refuse and say what is missing.
    const refused = await tools.get('mc_build_schematic').execute({
      schematic: generated.name,
      position: { x: wx + 2, y: wy, z: wz + 2 },
      dry_run: true
    }, exec)
    assert.equal(refused.ok, false, JSON.stringify(refused).slice(0, 300))
    assert.equal(refused.error, 'MISSING_MATERIALS')
    log(`PASS preflight: ${JSON.stringify(refused.missing ?? {})}`)

    const started = await tools.get('mc_build_schematic').execute({
      schematic: generated.name,
      position: { x: wx + 2, y: wy, z: wz + 2 },
      auto_gather: true
    }, exec)
    assert.equal(started.ok, true, JSON.stringify(started).slice(0, 400))
    log(`build started with gather: ${JSON.stringify(started.gather ? { ok: started.gather.ok, mode: started.gather.mode } : null)}`)
    assert.ok(started.gather, 'auto_gather should have run before the build')

    const finished = await until(() => {
      const snapshot = companion.build?.snapshot?.() ?? null
      if (!snapshot) return false
      return snapshot.status === 'running' ? false : snapshot
    }, { timeoutMs: 240_000, intervalMs: 1_000, label: 'build to finish' })

    assert.equal(finished.status, 'done', JSON.stringify(finished).slice(0, 400))
    assert.equal(finished.failed, 0, JSON.stringify(finished).slice(0, 400))
    const plank = bot.blockAt(new Vec3(wx + 2, wy, wz + 2))
    assert.equal(plank?.name, 'oak_planks', `expected planks at the origin, got ${plank?.name}`)
    log(`PASS build: ${finished.placed}/${finished.total} placed after self-gathering materials`)

    console.log('\n=== GATHER E2E PASS ===')
    process.exit(0)
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: 'gather e2e done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== GATHER E2E FAIL ===')
  console.error(error)
  process.exit(1)
})
