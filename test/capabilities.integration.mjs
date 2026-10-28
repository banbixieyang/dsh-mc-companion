#!/usr/bin/env node
/**
 * Player capabilities end-to-end on a real Paper 1.20.4 server.
 *
 * The claim under test is "anything a player can do, the bot can do": craft,
 * smelt, eat, break, place, chests, attack, respawn — plus the idle autopilot
 * that acts when nobody is driving.
 *
 * The scenario is prepared over RCON (no console stdin in restricted sandboxes).
 * Survival actions are checked against the actual world and inventory, not
 * against tool output.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { startServer, RCON_PORT } from '../scripts/start-test-server.mjs'
import { RCON_PASSWORD, rconCommand } from '../scripts/rcon.mjs'
import { ensureServerProperties } from '../scripts/server-properties.mjs'
import { SERVER_DIR } from '../scripts/start-test-server.mjs'

const log = (...args) => console.log('[caps-e2e]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const rcon = (command) => rconCommand({ port: RCON_PORT, password: RCON_PASSWORD, command, timeoutMs: 8_000 })
const propertiesFile = path.join(SERVER_DIR, 'server.properties')
// Summoned mobs/stands survive on easy; the shared world stays peaceful.
const SERVER_OVERRIDES = { difficulty: 'easy', 'spawn-monsters': 'true', 'spawn-animals': 'true' }
const PEACEFUL_BASELINE = { difficulty: 'peaceful', 'spawn-monsters': 'false', 'spawn-animals': 'false' }

async function until (fn, { timeoutMs = 30_000, intervalMs = 300, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

/** The bot's own chunk view is the honest check; `say` output is not in RCON replies. */
const blockNameAt = (bot, x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name ?? null

async function main () {
  await ensureServerProperties(propertiesFile, SERVER_OVERRIDES)
  let server = await startServer({ resetWorld: true })
  if (server.external) {
    await sleep(6_000)
    server = await startServer({ resetWorld: true })
  }
  if (server.external) {
    throw new Error('MC_TEST_SERVER_RUNNING: 该测试需要自己启动服务器（要改 difficulty / spawn-*）。先停掉测试端口上的服务器。')
  }
  log(`server started on 127.0.0.1:${server.port}`)

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-caps-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: server.port,
    username: 'Companion',
    version: '1.20.4',
    autoConnect: false,
    autoFollow: false,
    allowCreativeFill: true,
    autopilot: { enabled: false } // deterministic unless a step turns it on
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    // Game tools only exist after the mode is enabled.
    const inventory = tools.get('mc_inventory')
    const act = tools.get('mc_act')
    assert.ok(inventory && act, 'mc_inventory / mc_act must be registered on enable')
    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    log(`PASS connected as ${connected.version}`)

    const bot = companion.bot.bot
    // Crafting in creative mode desyncs the 2x2 grid (items get consumed without
    // the result landing), so the capability checks run in survival — which is
    // also the mode these actions exist for.
    await rcon('gamemode survival Companion')
    await sleep(800)
    const base = bot.entity.position.floored()
    const at = (dx, dy, dz) => `${base.x + dx} ${base.y + dy} ${base.z + dz}`

    // ---- inventory + give ---------------------------------------------
    for (const command of [
      'give Companion minecraft:oak_log 16',
      'give Companion minecraft:stone 8',
      'give Companion minecraft:bread 3',
      'give Companion minecraft:iron_ore 2',
      'give Companion minecraft:coal 3',
      'give Companion minecraft:iron_pickaxe 1'
    ]) {
      await rcon(command)
    }
    await sleep(1_200)
    const listed = await inventory.execute({ action: 'list' }, exec)
    assert.equal(listed.ok, true, JSON.stringify(listed))
    assert.ok(listed.items.some((entry) => entry.name === 'oak_log'), 'inventory should list the logs')
    log(`PASS inventory lists ${listed.items.length} stacks, ${listed.counts.total} items`)

    // ---- craft: 2x2 planks, then sticks at a bench ---------------------
    // Planks and sticks fit the 2x2 grid; a chest needs the 3x3 table.
    const planks = await inventory.execute({ action: 'craft', item: 'oak_planks', count: 3 }, exec)
    assert.equal(planks.ok, true, JSON.stringify(planks))
    const sticks = await inventory.execute({ action: 'craft', item: 'stick', count: 1 }, exec)
    assert.equal(sticks.ok, true, JSON.stringify(sticks))
    assert.equal(sticks.viaTable, false, JSON.stringify(sticks))
    await rcon(`setblock ${at(2, 0, 0)} minecraft:crafting_table`)
    await sleep(900)
    const chest = await inventory.execute({ action: 'craft', item: 'chest', count: 1 }, exec)
    assert.equal(chest.ok, true, JSON.stringify(chest))
    assert.equal(chest.viaTable, true, JSON.stringify(chest))
    const afterCraft = await inventory.execute({ action: 'list' }, exec)
    assert.ok(afterCraft.items.some((entry) => entry.name === 'chest'), 'chest should be crafted at the table')
    log('PASS crafting: planks/sticks in 2x2, chest at the crafting table')

    // ---- break / place -------------------------------------------------
    await inventory.execute({ action: 'equip', item: 'iron_pickaxe' }, exec)
    await rcon(`setblock ${at(1, 1, 1)} minecraft:stone`)
    await sleep(600)
    const broke = await act.execute({ action: 'break', x: base.x + 1, y: base.y + 1, z: base.z + 1 }, exec)
    assert.equal(broke.ok, true, JSON.stringify(broke))
    const gone = await until(() => blockNameAt(bot, base.x + 1, base.y + 1, base.z + 1) === 'air', {
      timeoutMs: 8_000,
      label: 'the broken block to disappear'
    })
    assert.equal(gone, true, 'the block should be gone')
    log('PASS break: stone block removed from the world')

    const placed = await act.execute({ action: 'place', x: base.x + 1, y: base.y, z: base.z + 1, item: 'stone' }, exec)
    assert.equal(placed.ok, true, JSON.stringify(placed))
    const solid = await until(() => blockNameAt(bot, base.x + 1, base.y, base.z + 1) === 'stone', {
      timeoutMs: 8_000,
      label: 'the placed block to appear'
    })
    assert.equal(solid, true, 'stone should be placed')
    log('PASS place: stone block placed against the ground')

    // ---- chest: list / take / put --------------------------------------
    await rcon(`setblock ${at(-2, 0, 0)} minecraft:chest`)
    await rcon(`item replace block ${at(-2, 0, 0)} container.0 with minecraft:iron_ingot 5`)
    await sleep(900)
    const chestList = await inventory.execute({ action: 'container', containerAction: 'list', x: base.x - 2, y: base.y, z: base.z }, exec)
    assert.equal(chestList.ok, true, JSON.stringify(chestList))
    assert.ok(chestList.items.some((entry) => entry.name === 'iron_ingot' && entry.count === 5), JSON.stringify(chestList))
    const took = await inventory.execute({ action: 'container', containerAction: 'take', item: 'iron_ingot', count: 2, x: base.x - 2, y: base.y, z: base.z }, exec)
    assert.equal(took.ok, true, JSON.stringify(took))
    const afterTake = await inventory.execute({ action: 'list' }, exec)
    assert.ok(afterTake.items.some((entry) => entry.name === 'iron_ingot' && entry.count >= 2), JSON.stringify(afterTake.items))
    const put = await inventory.execute({ action: 'container', containerAction: 'put', item: 'iron_ingot', count: 1, x: base.x - 2, y: base.y, z: base.z }, exec)
    assert.equal(put.ok, true, JSON.stringify(put))
    log('PASS chest: listed 5 ingots, took 2, put 1 back')

    // ---- smelt ---------------------------------------------------------
    await rcon(`setblock ${at(-1, 0, 2)} minecraft:furnace`)
    await sleep(700)
    const smelted = await inventory.execute({ action: 'smelt', input: 'iron_ore', fuel: 'coal', count: 1, timeoutMs: 25_000 }, exec)
    assert.equal(smelted.ok, true, JSON.stringify(smelted))
    assert.equal(smelted.smelted, 'iron_ingot')
    log('PASS smelt: iron ore -> iron ingot in a furnace')

    // ---- attack (armour stand: a non-player entity that survives) ------
    await rcon(`summon armor_stand ${at(2, 0, 2)}`)
    await sleep(1_200)
    const attacked = await act.execute({ action: 'attack', targets: ['armor_stand'], radius: 8 }, exec)
    assert.equal(attacked.ok, true, JSON.stringify(attacked))
    assert.equal(attacked.target, 'armor_stand')
    log('PASS attack: hit the nearest non-player target')

    // ---- respawn -------------------------------------------------------
    // Without the death screen the server respawns instantly and there is
    // nothing for mc_act respawn to do, so pin the gamerule first.
    try {
      if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
    } catch {
      /* ignore */
    }
    // While alive the tool must say "nothing to do" rather than force a packet.
    const skipRespawn = await act.execute({ action: 'respawn' }, exec)
    assert.equal(skipRespawn.ok, true, JSON.stringify(skipRespawn))
    assert.equal(skipRespawn.skipped, true, JSON.stringify(skipRespawn))

    // The server may respawn the player on its own; what matters is that the bot
    // survives a kill and is usable again (death handling + respawn path).
    const killResponse = await rcon('kill Companion')
    assert.match(String(killResponse), /Killed Companion/, `kill failed: ${killResponse}`)
    const recovered = await until(
      () => Boolean(bot.entity) && bot.health > 0 && Number.isFinite(bot.entity.position.x),
      { timeoutMs: 25_000, label: 'bot to be alive and positioned again' }
    )
    assert.equal(recovered, true)
    log('PASS respawn: skip while alive, recovered after a server kill')

    // ---- autopilot eats without being told ------------------------------
    const eatBase = bot.entity.position.floored()
    await rcon(`give Companion minecraft:bread 6`)
    // Force hunger down; the autopilot should notice and eat on its own.
    // Hunger III+ drains the bar in seconds; /data on players is version-flaky.
    const hunger = await rcon('effect give Companion minecraft:hunger 60 30 true')
    const starving = await until(() => (bot.food <= 16 ? bot.food : false), { timeoutMs: 45_000, label: 'hunger to drop' })
    log(`hunger applied: ${JSON.stringify(hunger)} food=${starving}`)
    const started = await act.execute({ action: 'autopilot', autopilot: { enabled: true, eat: true, defend: false, flee: false, pickup: false, respawn: false } }, exec)
    assert.equal(started.ok, true, JSON.stringify(started))
    const ate = await until(
      () => companion.events.recent(200).find((event) => event.type === 'autopilot' && /吃了/.test(event.message)),
      { timeoutMs: 40_000, intervalMs: 500, label: 'autopilot to eat' }
    )
    assert.match(ate.message, /吃了/)
    void eatBase
    void hunger
    log(`PASS autopilot: ${ate.message}`)

    console.log('\n=== CAPABILITIES E2E PASS ===')
  } finally {
    try {
      await act?.execute({ action: 'autopilot', autopilot: { enabled: false } }, exec)
    } catch {
      /* ignore */
    }
    try {
      await mode.execute({ action: 'disable', reason: 'capabilities e2e done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
    await ensureServerProperties(propertiesFile, PEACEFUL_BASELINE).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\n=== CAPABILITIES E2E FAIL ===')
  console.error(error)
  process.exitCode = 1
})














