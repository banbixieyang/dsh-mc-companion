/**
 * Live demo: keeps the bot, the server and the first-person view alive so the
 * run can actually be watched (the E2E tears everything down when it exits).
 *
 * Usage: node scripts/live-view.mjs [minutes=15] [plan=speedrun]
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { install } from '../index.js'
import { createFakeCtx, execContext } from '../test/helpers/fake-ctx.mjs'
import { RCON_PORT, startServer } from './start-test-server.mjs'
import { RCON_PASSWORD, rconCommand } from './rcon.mjs'

const minutes = Number(process.argv[2] ?? 15)
const plan = String(process.argv[3] ?? 'speedrun')
const VIEWER_PORT = 3010
const log = (...args) => console.log(`[live ${new Date().toLocaleTimeString()}]`, ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (command) => rconCommand({ port: RCON_PORT, password: RCON_PASSWORD, command, timeoutMs: 8_000 })

async function main () {
  const server = await startServer({ resetWorld: true })
  if (server.external) throw new Error('MC_TEST_SERVER_RUNNING: 先停掉测试端口上的服务器。')
  log(`server on 127.0.0.1:${server.port}`)

  // A workshop worth watching: trees, stone, ore, and a bell for structure scans.
  const wx = 0
  const wy = -60
  const wz = 0
  for (const [dx, dz] of [[2, 0], [3, 1], [4, -1]]) {
    for (const dy of [1, 2, 3]) await rcon(`setblock ${wx + dx} ${wy + dy} ${wz + dz} minecraft:oak_log`)
  }
  for (const [dx, dz] of [[-2, 0], [-2, 1], [-2, -1], [0, 2], [1, 2], [-1, 2], [0, -2], [1, -2], [-1, -2], [2, 2], [-2, 2], [2, -2], [3, 2], [-3, 2]]) {
    await rcon(`setblock ${wx + dx} ${wy} ${wz + dz} minecraft:stone`)
  }
  for (const [dx, dz] of [[3, 3], [4, 2]]) await rcon(`setblock ${wx + dx} ${wy} ${wz + dz} minecraft:iron_ore`)
  for (const [dx, dz] of [[-3, 3]]) await rcon(`setblock ${wx + dx} ${wy} ${wz + dz} minecraft:coal_ore`)
  await rcon(`setblock ${wx + 6} ${wy + 1} ${wz + 4} minecraft:bell`)
  await rcon('time set day')
  log('workshop ready')

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-live-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: server.port,
    username: 'LiveBot',
    version: '1.20.4',
    autoConnect: false,
    autoFollow: false,
    autopilot: { enabled: true },
    behaviors: { explore: false, woodcut: true, mine: true, fight: true },
    speedrun: { enabled: true },
    viewer: { enabled: true, port: VIEWER_PORT, firstPerson: true, viewDistance: 6 }
  })
  const exec = execContext()

  await tools.get('mc_companion_mode').execute({ action: 'enable', connect: false }, exec)
  const connected = await tools.get('mc_bot_connect').execute({}, exec)
  if (!connected.ok) throw new Error(`connect failed: ${JSON.stringify(connected)}`)
  await rcon('gamemode survival LiveBot')
  await rcon('clear LiveBot')
  await rcon(`tp LiveBot ${wx} ${wy} ${wz}`)
  await sleep(2_500)

  const viewer = companion.viewer.snapshot()
  log(viewer.running ? `LIVE VIEW: ${viewer.url}` : `viewer failed: ${viewer.error}`)

  const started = await tools.get('mc_solo').execute({ action: 'start', plan }, exec)
  log(started.ok ? `plan ${plan} started (${started.total} steps)` : `plan refused: ${started.message ?? started.error}`)

  // Stay alive: report progress, keep the viewer up, then leave it running.
  const until = Date.now() + minutes * 60_000
  let lastStep = -1
  while (Date.now() < until) {
    const solo = companion.solo.snapshot()
    if (solo.step !== lastStep && solo.step !== null) {
      lastStep = solo.step
      log(`step ${solo.step + 1}/${solo.total}: ${solo.steps[solo.step]?.label}`)
    }
    if (!solo.running && solo.finishedAt) {
      log(`plan finished: ${solo.error ?? 'ok'} (${(solo.elapsedMs / 1000).toFixed(1)}s)`)
      break
    }
    await sleep(2_000)
  }

  // Keep the view open even after the plan ends.
  log(`keeping the view alive for ${minutes} more minutes at ${companion.viewer.snapshot().url}`)
  await sleep(minutes * 60_000)
  await tools.get('mc_companion_mode').execute({ action: 'disable', reason: 'live demo over' }, exec)
  await ctx.dispose()
  await server.stop()
}

main().catch((error) => {
  console.error('[live] failed:', error)
  process.exit(1)
})
