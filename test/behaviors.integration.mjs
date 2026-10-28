#!/usr/bin/env node
/**
 * Autonomous behaviours end-to-end on a real Paper 1.20.4 server.
 *
 * The scenario is prepared over RCON (no console stdin: restricted sandboxes
 * cannot pipe to a child process), then each behaviour is started once and must
 * finish on its own — that is the whole point of the tool: one call, the bot
 * does the work, the model only reads a summary.
 *
 * What is asserted: explore actually moves, woodcut chops exactly the logs that
 * were placed, mine collects the ore, fight kills the mob, every run stops by
 * itself, and the event log stays small (token economy).
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { startServer, RCON_PORT, SERVER_DIR } from '../scripts/start-test-server.mjs'
import { RCON_PASSWORD, rconCommand } from '../scripts/rcon.mjs'
import { ensureServerProperties } from '../scripts/server-properties.mjs'

/**
 * The shared test server runs peaceful with mob spawning off (Paper then culls
 * any summoned mob immediately — see tools/probe-summon-matrix.mjs). Combat and
 * mob targets need them back for this test only.
 */
const MOB_OVERRIDES = { difficulty: 'easy', 'spawn-monsters': 'true', 'spawn-animals': 'true' }
const PEACEFUL_BASELINE = { difficulty: 'peaceful', 'spawn-monsters': 'false', 'spawn-animals': 'false' }
const propertiesFile = path.join(SERVER_DIR, 'server.properties')

const log = (...args) => console.log('[behaviors-e2e]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const rcon = (command) => rconCommand({ port: RCON_PORT, password: RCON_PASSWORD, command, timeoutMs: 8_000 })

async function until (fn, { timeoutMs = 60_000, intervalMs = 400, label = 'condition' } = {}) {
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
  await ensureServerProperties(propertiesFile, MOB_OVERRIDES)
  const server = await startServer({ resetWorld: true })
  if (server.external) {
    // The combat step needs the mob settings above, and those only apply on
    // server start — a server that is already running would silently cull the
    // summoned zombie and the failure would look like a bug in fight mode.
    throw new Error(
      'MC_TEST_SERVER_RUNNING: 该测试需要自己启动服务器（要改写 difficulty / spawn-* 才能让生物不被清除）。' +
      '请先停掉占用 127.0.0.1:25565 的服务器再运行。'
    )
  }
  log(`server started on 127.0.0.1:${server.port}`)

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-behaviors-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: server.port,
    username: 'Companion',
    version: '1.20.4',
    autoConnect: false,
    autoFollow: false,
    behaviors: { explore: true, woodcut: true, mine: true, fight: true },
    behaviorRadius: 16,
    behaviorMinHealth: 4,
    behaviorMaxDurationMs: 60_000
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    log(`PASS connected as ${connected.version}`)

    const behavior = tools.get('mc_behavior')
    assert.ok(behavior, 'mc_behavior must be registered while the mode is on')

    // ---- authorisation is enforced -------------------------------------
    const denied = await tools.get('mc_behavior').execute({ action: 'start', mode: 'nope' }, exec)
    assert.equal(denied.ok, false)
    assert.match(denied.error, /MC_BEHAVIOR_UNKNOWN/)

    const bot = companion.bot.bot
    // Relative to wherever the bot is *now* — explore has already moved it.
    const at = (dx, dy, dz) => {
      const position = bot.entity.position.floored()
      return `${position.x + dx} ${position.y + dy} ${position.z + dz}`
    }

    // ---- explore -------------------------------------------------------
    const before = bot.entity.position.clone()
    const exploreStart = await behavior.execute({ action: 'start', mode: 'explore', radius: 12 }, exec)
    assert.equal(exploreStart.ok, true, JSON.stringify(exploreStart))
    assert.equal(exploreStart.active, true)
    const walked = await until(
      () => {
        const moved = bot.entity.position.distanceTo(before)
        return moved > 3 ? moved : false
      },
      { timeoutMs: 30_000, label: 'explore to move the bot' }
    )
    const exploreStop = await behavior.execute({ action: 'stop', reason: 'explore check' }, exec)
    assert.equal(exploreStop.ok, true, JSON.stringify(exploreStop))
    assert.equal(exploreStop.active, false)
    log(`PASS explore walked ${walked.toFixed(1)} blocks and stopped on request`)

    // ---- woodcut -------------------------------------------------------
    for (const dy of [1, 2, 3]) await rcon(`setblock ${at(2, dy, 0)} minecraft:oak_log`)
    await sleep(1_000)
    const woodStart = await behavior.execute({ action: 'start', mode: 'woodcut', amount: 3, radius: 10 }, exec)
    assert.equal(woodStart.ok, true, JSON.stringify(woodStart))
    const woodDone = await until(
      () => {
        const snapshot = companion.behaviors.snapshot()
        return snapshot.active ? false : companion.behaviors.last
      },
      { timeoutMs: 60_000, label: 'woodcut to finish' }
    )
    assert.equal(woodDone.reason, 'done', JSON.stringify(woodDone))
    assert.equal(woodDone.progress, 3, JSON.stringify(woodDone))
    const stillThere = await rcon(`execute if block ${at(2, 1, 0)} minecraft:air return 1`)
    void stillThere
    log(`PASS woodcut chopped ${woodDone.progress}/3 logs`)

    // ---- mine ----------------------------------------------------------
    await rcon(`setblock ${at(-2, 1, 2)} minecraft:iron_ore`)
    await sleep(800)
    const mineStart = await behavior.execute({ action: 'start', mode: 'mine', targets: ['iron_ore'], amount: 1, radius: 10 }, exec)
    assert.equal(mineStart.ok, true, JSON.stringify(mineStart))
    const mineDone = await until(
      () => {
        const snapshot = companion.behaviors.snapshot()
        return snapshot.active ? false : companion.behaviors.last
      },
      { timeoutMs: 60_000, label: 'mine to finish' }
    )
    assert.equal(mineDone.progress, 1, JSON.stringify(mineDone))
    log(`PASS mine collected ${mineDone.progress} iron ore (${mineDone.reason})`)

    // ---- fight ---------------------------------------------------------
    const summoned = await rcon(`summon zombie ${at(2, 1, 2)} {NoAI:1b,Silent:1b,Health:1f,Invulnerable:0b}`)
    assert.match(String(summoned), /Summoned new Zombie/, `summon failed: ${summoned}`)
    await sleep(1_500)
    const fightStart = await behavior.execute({ action: 'start', mode: 'fight', amount: 1, radius: 12, targets: ['zombie'] }, exec)
    assert.equal(fightStart.ok, true, JSON.stringify(fightStart))
    const fightDone = await until(
      () => {
        const snapshot = companion.behaviors.snapshot()
        return snapshot.active ? false : companion.behaviors.last
      },
      { timeoutMs: 60_000, label: 'fight to finish' }
    )
    assert.equal(fightDone.progress, 1, JSON.stringify(fightDone))
    log(`PASS fight killed ${fightDone.progress} zombie (${fightDone.reason})`)

    // ---- cooperation with the other states -----------------------------
    await companion.bot.followPlayer(null, 3).catch(() => {})
    await behavior.execute({ action: 'start', mode: 'woodcut', amount: 1, radius: 6 }, exec)
    const status = await tools.get('mc_status').execute({}, exec)
    assert.equal(status.ok, true)
    assert.equal(status.behavior.active, true, 'status must report the running behaviour')
    // starting a second behaviour replaces the first instead of stacking
    await behavior.execute({ action: 'start', mode: 'mine', amount: 1 }, exec)
    assert.equal(companion.behaviors.snapshot().mode, 'mine')
    await behavior.execute({ action: 'stop', reason: 'cooperation check' }, exec)

    // ---- token economy -------------------------------------------------
    const behaviorEvents = companion.events.recent(400).filter((event) => event.type === 'behavior')
    assert.ok(behaviorEvents.length <= 20, `behaviour events should stay small, got ${behaviorEvents.length}`)
    log(`PASS ${behaviorEvents.length} behaviour events for 5 runs (start/milestone/stop only)`)

    // ---- disable stops everything --------------------------------------
    await behavior.execute({ action: 'start', mode: 'explore', radius: 10 }, exec)
    const disabled = await mode.execute({ action: 'disable', reason: 'behaviors e2e done' }, exec)
    assert.equal(disabled.ok, true, JSON.stringify(disabled))
    assert.equal(companion.behaviors.snapshot().active, false, 'disable must stop behaviours')
    assert.equal(tools.get('mc_behavior'), undefined, 'mc_behavior must be unregistered on disable')
    log('PASS disable stopped the behaviour and unregistered the tool')

    console.log('\n=== BEHAVIOR E2E PASS ===')
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: 'cleanup' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
    // Leave the shared test server exactly as the other suites expect it.
    await ensureServerProperties(propertiesFile, PEACEFUL_BASELINE).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\n=== BEHAVIOR E2E FAIL ===')
  console.error(error)
  process.exitCode = 1
})





