#!/usr/bin/env node
/**
 * Stuck-in-a-pit acceptance test.
 *
 * Boots a disposable Paper server, drops the bot into a 3-block-deep pit, then
 * asks it to build a single block on the surface. With `allow_scaffold` the
 * pathfinder must jump-place blocks under itself to climb out; afterwards the
 * passive (no-tower) movements must be restored.
 *
 * Run: node test/scaffold.integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { prepareServer } from '../scripts/setup-test-server.mjs'
import { startServer } from '../scripts/start-test-server.mjs'

const PORT = Number(process.env.MC_TEST_PORT ?? 25570)
const log = (...args) => console.log('[scaffold-e2e]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(fn, { timeoutMs = 30_000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

async function main() {
  await prepareServer()
  const server = await startServer({ port: PORT, resetWorld: true })
  log(`server ready on 127.0.0.1:${PORT}${server.external ? ' (existing — cannot drive console, aborting)' : ''}`)
  if (server.external) {
    throw new Error('scaffold test needs to own the server (console fill/tp); stop other servers on 25570 first')
  }

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-scaffold-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: PORT,
    username: 'PitBot',
    autoConnect: false,
    allowCreativeFill: true,
    allowScaffold: true,
    scaffoldBlocks: ['dirt'],
    scaffoldBudget: 8,
    buildSpeed: 30,
    followRadius: 2,
    schematicVersion: '1.20.4',
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    log(`connected at ${JSON.stringify(connected.position)}`)

    // 3-deep pit: surface is y=-61, floor bedrock y=-64, bot feet y=-63.
    server.write('fill 18 -63 18 22 -61 22 air')
    server.write('tp PitBot 20 -63 20')
    await until(
      () => companion.bot.bot?.entity?.position?.distanceTo(new Vec3(20, -63, 20)) < 2,
      { timeoutMs: 15_000, label: 'teleport into pit' },
    )
    await companion.bot.bot.waitForChunksToLoad().catch(() => {})
    const pitY = companion.bot.bot.entity.position.y
    log(`bot is in the pit at y=${pitY}`)

    // A single block on the surface, four blocks away from the pit.
    const gen = await tools.get('mc_generate_schematic').execute(
      {
        spec: {
          name: 'one_block',
          size: { x: 1, y: 1, z: 1 },
          palette: { A: 'minecraft:stone', '.': 'minecraft:air' },
          layers: [{ y: 0, rows: ['A'] }],
        },
        version: '1.20.4',
      },
      exec,
    )
    assert.equal(gen.ok, true, JSON.stringify(gen))

    const build = await tools.get('mc_build_schematic').execute(
      {
        schematic: 'one_block',
        position: { x: 20, y: -60, z: 30 },
        wait_ms: 60_000,
        allow_creative_fill: true,
        allow_scaffold: true,
      },
      exec,
    )
    assert.equal(build.ok, true, JSON.stringify(build))
    const finished = await until(
      () => {
        const status = companion.build?.snapshot?.()
        return status && status.status !== 'running' ? status : false
      },
      { timeoutMs: 60_000, intervalMs: 1_000, label: 'build to finish' },
    )
    assert.equal(finished.status, 'done', JSON.stringify(finished))
    assert.equal(finished.placed, 1, JSON.stringify(finished))
    const finalY = companion.bot.bot.entity.position.y
    log(`finished: ${JSON.stringify(finished)}`)
    log(`final y=${finalY}`)
    log(
      companion.events
        .list({ limit: 60 })
        .filter((event) => event.type.startsWith('build'))
        .map((event) => `${event.type}: ${event.message}`)
        .join('\n'),
    )
    assert.ok(finished.scaffold?.used >= 1, `expected scaffold blocks to be used, got ${JSON.stringify(finished.scaffold)}`)
    assert.ok(finalY >= -60, `bot did not leave the pit: y=${finalY}`)
    assert.equal(companion.bot.bot.pathfinder.movements?.allow1by1towers, false)
    log(`PASS climbed out of the pit (y ${pitY} -> ${finalY}), scaffold used=${finished.scaffold.used}, placed=${finished.placed}`)

    const events = companion.events.list({ limit: 30, typePrefix: 'build_scaffold' })
    log(events.map((event) => event.message).join('\n'))
    console.log('\n=== SCAFFOLD E2E PASS ===')
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: 'scaffold e2e done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== SCAFFOLD E2E FAIL ===')
  console.error(error)
  process.exitCode = 1
})

