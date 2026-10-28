#!/usr/bin/env node
/**
 * Native Minecraft 26.3 E2E: a Paper 26.3 server with **no** ViaVersion, and a
 * bot that speaks client 26.3 (protocol 777) directly.
 *
 * Everything this asserts is a protocol surface the 26.3 patch has to get right:
 * login + configuration registry data, chunk + light decoding, position sync,
 * chat, block placement and block reads.
 *
 * Prerequisite: run `node scripts/install-263-compat.mjs` once (npm-postinstall
 * does it) so minecraft-data/minecraft-protocol/mineflayer/prismarine-chunk know
 * 26.3.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { startServer263, RCON_PORT_263 } from '../scripts/test-server-26.mjs'
import { RCON_PASSWORD, rconCommand } from '../scripts/rcon.mjs'
import { runCompatCheck } from '../scripts/install-263-compat.mjs'

const PORT = 25566
const log = (...args) => console.log('[26.3-native]', ...args)
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
  assert.equal(await runCompatCheck(), true, 'the 26.3 compat layer is not installed: run scripts/install-263-compat.mjs')

  process.env.MC_NO_VIA = '1'
  const rcon = (command) => rconCommand({ port: RCON_PORT_263, password: RCON_PASSWORD, command, timeoutMs: 8_000 })
  const server = await startServer263({
    resetWorld: true,
    // Combat/dig behaviours need mobs; the shared world stays peaceful otherwise.
    extraProperties: { difficulty: 'easy', 'spawn-monsters': 'true', 'spawn-animals': 'true' },
    onLog: (line) => (process.env.MC_TEST_VERBOSE ? log(line) : undefined),
  })
  log(`server reachable on 127.0.0.1:${PORT}${server.external ? ' (existing)' : ''} (no ViaVersion)`)
  if (server.external) {
    // Mob settings can only be applied when this test starts the server itself.
    log('WARN: 复用已有服务器；生物生成设置无法应用，打怪步骤会被跳过')
  }

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-native263-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: PORT,
    username: 'NativeBot',
    version: '26.3',
    autoConnect: false,
    autoVersionFallback: false,
    allowCreativeFill: true,
    allowScaffold: true,
    behaviors: { explore: true, woodcut: true, mine: true, fight: true },
    buildSpeed: 20,
    followRadius: 2,
    schematicVersion: '26.3',
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)

    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    assert.equal(connected.version, '26.3', JSON.stringify(connected))
    assert.equal(connected.versionFallback, null, JSON.stringify(connected))
    log(`PASS connected natively as client ${connected.version} (server protocol 777)`)

    const status = await tools.get('mc_status').execute({}, exec)
    assert.equal(status.ok, true, JSON.stringify(status))
    log(`PASS status: ${JSON.stringify(status.position ?? status.state ?? status)}`)

    // Chunk decoding: the spawn column must resolve real blocks, not air.
    const ground = await until(
      () => {
        const bot = companion.bot.bot
        const p = bot.entity?.position?.floored()
        if (!p) return false
        const below = bot.blockAt(new Vec3(p.x, p.y - 1, p.z))
        return below && below.name !== 'air' ? below.name : false
      },
      { timeoutMs: 40_000, intervalMs: 500, label: 'chunk data with real blocks' },
    )
    log(`PASS chunk decode: block under the bot is ${ground}`)

    const chat = await tools.get('mc_chat').execute({ message: '26.3 native: hello' }, exec)
    assert.equal(chat.ok, true, JSON.stringify(chat))
    log('PASS chat packet accepted')

    const gen = await tools.get('mc_generate_schematic').execute(
      {
        spec: {
          name: 'native_floor',
          size: { x: 3, y: 1, z: 3 },
          palette: { A: 'minecraft:oak_planks', '.': 'minecraft:air' },
          layers: [{ y: 0, rows: ['AAA', 'AAA', 'AAA'] }],
        },
        version: '26.3',
      },
      exec,
    )
    assert.equal(gen.ok, true, JSON.stringify(gen))
    log('PASS 26.3 schematic generated')

    const base = companion.bot.bot.entity.position.floored()
    const origin = { x: base.x + 4, y: base.y, z: base.z + 2 }
    const build = await tools.get('mc_build_schematic').execute(
      { schematic: 'native_floor', position: origin, wait_ms: 60_000, allow_creative_fill: true },
      exec,
    )
    assert.equal(build.ok, true, JSON.stringify(build))
    const finished = await until(
      () => {
        const snapshot = companion.build?.snapshot?.()
        return snapshot && snapshot.status !== 'running' ? snapshot : false
      },
      { timeoutMs: 60_000, intervalMs: 1_000, label: 'build to finish' },
    )
    assert.equal(finished.status, 'done', JSON.stringify(finished))
    assert.equal(finished.placed, 9, JSON.stringify(finished))

    const at = (dx, dz) => companion.bot.bot.blockAt(new Vec3(origin.x + dx, origin.y, origin.z + dz))?.name
    assert.equal(at(0, 0), 'oak_planks')
    assert.equal(at(2, 2), 'oak_planks')
    log(`PASS placed ${finished.placed}/9 blocks natively and read them back`)

    // Entity tracking: a second bot walking exercises the 26.3 packed entity
    // delta (entityDelta) on the wire. A misparsed delta would leave the walker
    // frozen at its spawn point or teleport it to a garbage position.
    const mineflayerModule = await import('mineflayer')
    const mineflayer = mineflayerModule.default ?? mineflayerModule
    const walkerName = `Walker${Date.now() % 1000}`
    const walker = mineflayer.createBot({
      host: '127.0.0.1',
      port: PORT,
      username: walkerName,
      version: '26.3',
      auth: 'offline'
    })
    try {
      await new Promise((resolve, reject) => {
        walker.once('spawn', resolve)
        walker.once('error', reject)
        walker.once('kicked', (reason) => reject(new Error(`walker kicked: ${JSON.stringify(reason)}`)))
      })
      const seen = () => Object.values(companion.bot.bot.entities).find((entity) => entity.username === walkerName)
      const start = await until(() => (seen() ? seen().position.clone() : false), {
        timeoutMs: 20_000,
        label: 'walker to appear in the companion entity list'
      })
      walker.setControlState('forward', true)
      await sleep(1_500)
      walker.setControlState('forward', false)
      const travelled = await until(
        () => {
          const entity = seen()
          if (!entity) return false
          const distance = entity.position.distanceTo(start)
          return distance > 1 && distance < 20 ? distance : false
        },
        { timeoutMs: 20_000, intervalMs: 300, label: 'companion to track the walker (packed entity delta)' }
      )
      log(`PASS entity tracking: companion followed the walker across ${travelled.toFixed(2)} blocks`)
    } finally {
      try {
        walker.quit()
      } catch {
        /* ignore */
      }
    }

    // Digging and combat go through 26.3's own packets (block_dig with a
    // sequence number, and the `attack` packet), so both are exercised here.
    const mine = await tools.get('mc_behavior').execute(
      { action: 'start', mode: 'mine', targets: ['oak_planks'], amount: 3, radius: 8 },
      exec
    )
    assert.equal(mine.ok, true, JSON.stringify(mine))
    const mined = await until(
      () => {
        const snapshot = companion.behaviors.snapshot()
        return snapshot.active ? false : companion.behaviors.last
      },
      { timeoutMs: 60_000, label: 'native mine to finish' }
    )
    assert.equal(mined.progress, 3, JSON.stringify(mined))
    log(`PASS mine dug ${mined.progress} placed blocks natively (${mined.reason})`)

    if (!server.external) {
      // An armour stand is a static non-player target: it exercises the same
      // approach → attack → kill-counting path as a mob, without the flakiness
      // of summoning a living entity onto whatever terrain the bot is standing
      // on (mob fighting is covered end-to-end on 1.20.4).
      const here = companion.bot.bot.entity.position.floored()
      const summoned = await rcon(`summon armor_stand ${here.x + 2} ${here.y} ${here.z}`)
      assert.match(String(summoned), /Summoned new Armor Stand/, `summon failed: ${summoned}`)
      await sleep(1_200)
      const fight = await tools.get('mc_behavior').execute(
        { action: 'start', mode: 'fight', amount: 1, radius: 12, targets: ['armor_stand'] },
        exec
      )
      assert.equal(fight.ok, true, JSON.stringify(fight))
      const killed = await until(
        () => {
          const snapshot = companion.behaviors.snapshot()
          return snapshot.active ? false : companion.behaviors.last
        },
        { timeoutMs: 90_000, intervalMs: 1_000, label: 'native fight to finish' }
      )
      assert.equal(killed.progress, 1, JSON.stringify(killed))
      log(`PASS fight killed ${killed.progress} zombie natively (${killed.reason})`)
    }

    // Point-to-point walking on 26.3: same pathfinder, different protocol.
    const fromHere = companion.bot.bot.entity.position.floored()
    const destination = { x: fromHere.x + 6, y: fromHere.y, z: fromHere.z + 5 }
    const walked = await tools.get('mc_goto').execute(destination, exec)
    assert.equal(walked.ok, true, JSON.stringify(walked))
    const gap = companion.bot.bot.entity.position.distanceTo(
      new Vec3(destination.x, destination.y, destination.z)
    )
    assert.ok(gap <= 6, `expected to arrive near the destination, got ${gap}`)
    log(`PASS goto walked to ${destination.x},${destination.y},${destination.z} natively (within ${gap.toFixed(1)} blocks)`)

    // Stay alive: 26.3 kicks clients that skip client_tick_end.
    await sleep(4_000)
    assert.equal(companion.bot.bot.entity != null, true, 'bot was kicked after spawn')
    const after = await tools.get('mc_status').execute({}, exec)
    assert.equal(after.ok, true, JSON.stringify(after))
    log('PASS survived the tick_end enforcement window')

    console.log('\n=== 26.3 NATIVE E2E PASS ===')
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: 'native 26.3 test done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== 26.3 NATIVE E2E FAIL ===')
  console.error(error)
  process.exitCode = 1
})









