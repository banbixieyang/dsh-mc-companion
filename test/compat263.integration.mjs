#!/usr/bin/env node
/**
 * Experimental 26.3 compatibility test: Paper 26.3 + ViaVersion/ViaBackwards,
 * bot speaking client 26.1, with the plugin's automatic version fallback and
 * tick_end shim.
 *
 * Prerequisite: the 26.3 test server is already running on 127.0.0.1:25566
 * (see .test-server-26 / README section 8). This test does not need console
 * access; it only connects, chats and builds classic blocks.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { startServer263 } from '../scripts/test-server-26.mjs'

const PORT = 25566
const log = (...args) => console.log('[26.3-via]', ...args)
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
  const server = await startServer263({
    resetWorld: true,
    onLog: (line) => (process.env.MC_TEST_VERBOSE ? log(line) : undefined),
  })
  log(`server reachable on 127.0.0.1:${PORT}${server.external ? ' (existing)' : ''}`)

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-263-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: PORT,
    username: 'ViaBot',
    autoConnect: false,
    autoVersionFallback: true,
    allowCreativeFill: true,
    allowScaffold: true,
    buildSpeed: 20,
    followRadius: 2,
    schematicVersion: '26.1',
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    assert.equal(connected.version, '26.1', JSON.stringify(connected))
    // Mineflayer can auto-detect the Via bridge and pick 26.1 directly; the
    // explicit fallback path is still exercised by unit tests / other servers.
    assert.ok(connected.versionFallback === '26.1' || connected.versionFallback === null, JSON.stringify(connected))
    assert.equal(connected.tickEndCompat, true, JSON.stringify(connected))
    log(
      `PASS connected as client ${connected.version} (server 26.3/777), fallback=${connected.versionFallback ?? 'auto-detected'}`,
    )

    const chat = await tools.get('mc_chat').execute({ message: '26.3 via ViaBackwards: hello' }, exec)
    assert.equal(chat.ok, true, JSON.stringify(chat))
    log('PASS chat packet accepted by the 26.3 server')

    const gen = await tools.get('mc_generate_schematic').execute(
      {
        spec: {
          name: 'via_floor',
          size: { x: 3, y: 1, z: 3 },
          palette: { A: 'minecraft:oak_planks', '.': 'minecraft:air' },
          layers: [{ y: 0, rows: ['AAA', 'AAA', 'AAA'] }],
        },
        version: '26.1',
      },
      exec,
    )
    assert.equal(gen.ok, true, JSON.stringify(gen))

    const base = companion.bot.bot.entity.position.floored()
    const origin = { x: base.x + 4, y: base.y, z: base.z + 2 }
    const build = await tools.get('mc_build_schematic').execute(
      {
        schematic: 'via_floor',
        position: origin,
        wait_ms: 60_000,
        allow_creative_fill: true,
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
    assert.equal(finished.placed, 9, JSON.stringify(finished))

    const at = (dx, dz) => companion.bot.bot.blockAt(new Vec3(origin.x + dx, origin.y, origin.z + dz))?.name
    assert.equal(at(0, 0), 'oak_planks')
    assert.equal(at(2, 2), 'oak_planks')
    log(`PASS placed ${finished.placed}/9 blocks on a 26.3 server and verified them`)

    console.log('\n=== 26.3 VIA E2E PASS ===')
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: '26.3 via test done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== 26.3 VIA E2E FAIL ===')
  console.error(error)
  process.exitCode = 1
})
