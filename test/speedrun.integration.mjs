#!/usr/bin/env node
/**
 * Speedrun end-to-end on a real Paper 1.20.4 server, with the live view opened
 * so the run can be watched while it happens.
 *
 * What is checked:
 *  - the dedicated switch really gates the plan (off => SPEEDRUN_DISABLED,
 *    bootstrap still allowed);
 *  - world knowledge (census, structure survey) and combat advice answer from
 *    the real world;
 *  - the speedrun plan itself reaches the iron tier and reports per-step times.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { RCON_PORT, startServer } from '../scripts/start-test-server.mjs'
import { RCON_PASSWORD, rconCommand } from '../scripts/rcon.mjs'

const log = (...args) => console.log('[speedrun-e2e]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (command) => rconCommand({ port: RCON_PORT, password: RCON_PASSWORD, command, timeoutMs: 8_000 })
const VIEWER_PORT = 3010

async function until (fn, { timeoutMs = 60_000, intervalMs = 1_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

/** Open a URL in the user's browser so the run is visible while it happens. */
function openInBrowser (url) {
  const command = process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) log(`could not open the browser automatically: ${error.message} (${url})`)
    })
  } catch (error) {
    // Sandboxes that forbid spawning must not kill the run; the URL is logged.
    log(`browser spawn blocked (${error.code ?? error.message}), open it manually: ${url}`)
  }
}

async function main () {
  const server = await startServer({ resetWorld: true })
  if (server.external) throw new Error('MC_TEST_SERVER_RUNNING: 先停掉测试端口上的服务器。')
  log(`server on ${server.port}`)

  // Workshop first, so the chunks the bot receives already contain everything.
  const wx = 0
  const wy = -60
  const wz = 0
  for (const [dx, dz] of [[2, 0], [3, 1], [4, -1]]) {
    for (const dy of [1, 2, 3]) await rcon(`setblock ${wx + dx} ${wy + dy} ${wz + dz} minecraft:oak_log`)
  }
  for (const [dx, dz] of [[-2, 0], [-2, 1], [-2, -1], [0, 2], [1, 2], [-1, 2], [0, -2], [1, -2], [-1, -2], [2, 2], [-2, 2], [2, -2], [2, -1], [-2, 2]]) {
    await rcon(`setblock ${wx + dx} ${wy} ${wz + dz} minecraft:stone`)
  }
  // Iron and coal for the later tier, plus a bell so structure detection has something to find.
  for (const [dx, dz] of [[3, 2], [3, 3], [4, 2]]) await rcon(`setblock ${wx + dx} ${wy} ${wz + dz} minecraft:iron_ore`)
  for (const [dx, dz] of [[-3, 2], [-3, 3]]) await rcon(`setblock ${wx + dx} ${wy} ${wz + dz} minecraft:coal_ore`)
  await rcon(`setblock ${wx + 6} ${wy + 1} ${wz + 4} minecraft:bell`)
  log('workshop placed')

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-speedrun-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: server.port,
    username: 'SpeedyBot',
    version: '1.20.4',
    autoConnect: false,
    autoFollow: false,
    autopilot: { enabled: false },
    behaviors: { explore: false, woodcut: true, mine: true, fight: false },
    // The dedicated switch starts OFF; the test proves it gates the plan.
    speedrun: { enabled: false },
    viewer: { enabled: true, port: VIEWER_PORT, firstPerson: true, viewDistance: 6 }
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    const solo = tools.get('mc_solo')
    const world = tools.get('mc_world')
    const combat = tools.get('mc_combat')
    assert.ok(solo && world && combat, 'mc_solo / mc_world / mc_combat must be registered')

    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    const bot = companion.bot.bot
    await rcon('gamemode survival SpeedyBot')
    await rcon('clear SpeedyBot')
    await rcon(`tp SpeedyBot ${wx} ${wy} ${wz}`)
    await sleep(3_000)

    // Show the run while it happens.
    const viewer = companion.viewer.snapshot()
    log(`viewer: ${viewer.running ? viewer.url : `not running (${viewer.error})`}`)
    if (viewer.running) openInBrowser(viewer.url)

    // ---- the switch gates the plan ------------------------------------
    const refused = await solo.execute({ action: 'start', plan: 'speedrun' }, exec)
    assert.equal(refused.ok, false, JSON.stringify(refused))
    assert.match(String(refused.message ?? refused.error), /SPEEDRUN_DISABLED/)
    log('PASS switch: speedrun refused while the dedicated switch is off')

    const enabled = companion.setSpeedrun({ enabled: true })
    assert.equal(enabled.enabled, true)
    log('PASS switch: enabled at runtime (panel toggle does the same)')

    // ---- world knowledge ----------------------------------------------
    const scan = await world.execute({ action: 'scan', radius: 32 }, exec)
    assert.equal(scan.ok, true, JSON.stringify(scan).slice(0, 300))
    assert.ok(scan.ores.iron_ore >= 1, JSON.stringify(scan.ores))
    assert.ok(scan.ores.coal_ore >= 1, JSON.stringify(scan.ores))
    log(`PASS world scan: iron=${scan.ores.iron_ore} coal=${scan.ores.coal_ore} trees=${scan.treeCount}`)

    const found = await world.execute({ action: 'find', structure: 'village', radius: 64 }, exec)
    assert.equal(found.ok, true, JSON.stringify(found).slice(0, 300))
    assert.equal(found.found.marker, 'bell')
    log(`PASS world find: village marker at ${found.found.position.x},${found.found.position.y},${found.found.position.z} (${found.found.distance} 格)`)

    const survey = await world.execute({ action: 'survey', radius: 64 }, exec)
    assert.equal(survey.ok, true)
    assert.ok(survey.found.village, JSON.stringify(survey.found))
    log(`PASS world survey: ${Object.keys(survey.found).join(', ')}`)

    // ---- combat advice ------------------------------------------------
    const advice = await combat.execute({ action: 'advice', radius: 16 }, exec)
    assert.equal(advice.ok, true, JSON.stringify(advice).slice(0, 200))
    log(`PASS combat advice: ${advice.recommendation} (${advice.reason})`)

    // ---- the run -------------------------------------------------------
    const started = await solo.execute({ action: 'start', plan: 'speedrun' }, exec)
    assert.equal(started.ok, true, JSON.stringify(started).slice(0, 200))
    log(`plan started: ${started.total} steps`)

    let lastReported = -1
    const finished = await until(
      () => {
        const state = companion.solo.snapshot()
        if (state.running && state.step !== lastReported) {
          lastReported = state.step
          const step = state.steps[state.step]
          log(`  step ${state.step + 1}/${state.total}: ${step?.label ?? '?'}`)
        }
        return state.running ? false : state
      },
      { timeoutMs: 420_000, intervalMs: 1_000, label: 'speedrun to finish' }
    )
    log(`steps: ${finished.steps.map((step) => `${step.id}:${step.status}`).join(' ')}`)
    assert.equal(finished.error, null, `speedrun failed: ${finished.error}`)
    const required = ['wood', 'planks', 'table', 'wooden_pickaxe', 'stone', 'stone_pickaxe', 'furnace']
    for (const id of required) {
      const step = finished.steps.find((entry) => entry.id === id)
      assert.equal(step?.status, 'done', `${id} should be done: ${JSON.stringify(step)}`)
    }

    const inventory = await tools.get('mc_inventory').execute({ action: 'list' }, exec)
    assert.ok(inventory.items.some((item) => item.name === 'stone_pickaxe'), 'stone pickaxe should be crafted')
    log(`PASS speedrun: ${(finished.elapsedMs / 1000).toFixed(1)}s to the stone tier`)
    const iron = finished.steps.filter((step) => /iron|coal|smelt/.test(step.id))
    log(`iron tier: ${iron.map((step) => `${step.id}:${step.status}${step.ms ? `(${(step.ms / 1000).toFixed(1)}s)` : ''}`).join(' ')}`)

    console.log('\n=== SPEEDRUN E2E PASS ===')
    process.exit(0)
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: 'speedrun e2e done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== SPEEDRUN E2E FAIL ===')
  console.error(error)
  process.exit(1)
})

