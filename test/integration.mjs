#!/usr/bin/env node
/**
 * End-to-end acceptance test against a disposable local Paper server
 * (127.0.0.1:25565, online-mode=false, superflat, creative).
 *
 * It drives the real plugin through a fake Cordis context, so the tested path
 * is exactly the one DSH uses:
 *
 *   load -> only mc_companion_mode
 *   enable(connect:false) -> nine game tools appear
 *   connect -> offline bot spawns
 *   follow -> companion walks to the owner bot
 *   generate -> .schem lands in ./data/mc-companion/schematics
 *   build -> 7x3x7 house appears, progress events, materials preflight
 *   missing materials -> reported, zero placement
 *   disable -> tools gone, bot offline, timers cleared
 *
 * Run: node test/integration.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Vec3 } from 'vec3'

import { GAME_TOOL_NAMES, install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { prepareServer } from '../scripts/setup-test-server.mjs'
import { startServer } from '../scripts/start-test-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE = path.join(HERE, '..', 'examples', 'small_house.json')
const PORT = Number(process.env.MC_TEST_PORT ?? 25565)
const log = (...args) => console.log('[e2e]', ...args)

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitFor(emitter, event, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent)
      reject(new Error(`timed out waiting for ${label ?? event} (${timeoutMs}ms)`))
    }, timeoutMs)
    const onEvent = (...args) => {
      clearTimeout(timer)
      resolve(args)
    }
    emitter.once(event, onEvent)
  })
}

async function spawnOwner() {
  const mineflayerModule = await import('mineflayer')
  const mineflayer = mineflayerModule.default ?? mineflayerModule
  const owner = mineflayer.createBot({
    host: '127.0.0.1',
    port: PORT,
    username: 'Owner',
    auth: 'offline',
    hideErrors: true,
  })
  owner.on('error', (error) => log('owner error:', error.message))
  await waitFor(owner, 'spawn', 30_000, 'owner spawn')
  return owner
}

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

/** Highest solid block with air above it, scanning a small window. */
function findGround(bot, x, z) {
  for (let y = -50; y >= -64; y -= 1) {
    const block = bot.blockAt(new Vec3(x, y, z))
    if (!block || block.boundingBox === 'empty') continue
    const above = bot.blockAt(new Vec3(x, y + 1, z))
    if (!above || above.boundingBox === 'empty') return y
  }
  return null
}

async function main() {
  await prepareServer()
  const server = await startServer({
    port: PORT,
    resetWorld: true,
    onLog: (line) => (process.env.MC_TEST_VERBOSE ? log(line) : undefined),
  })
  log(`server ready on 127.0.0.1:${PORT}${server.external ? ' (existing)' : ''}`)

  const owner = await spawnOwner()
  log('owner bot spawned')

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-e2e-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: PORT,
    username: 'Companion',
    auth: 'offline',
    owner: 'Owner',
    autoConnect: false,
    autoFollow: true,
    followRadius: 2,
    connectTimeoutMs: 25_000,
    schematicVersion: '1.20.4',
    buildSpeed: 20,
    allowCreativeFill: true,
  })
  const exec = execContext({ id: 'session-e2e' })
  const mode = tools.get('mc_companion_mode')

  try {
    // ---- acceptance 1: load-time gate ----------------------------------
    assert.deepEqual([...tools.keys()], ['mc_companion_mode'])
    assert.equal(companion.bot.mineflayerLoaded, false)
    const disabledStatus = await mode.execute({ action: 'status' }, exec)
    assert.equal(disabledStatus.enabled, false)
    log('PASS load-time: only mc_companion_mode, no bot, no Mineflayer')

    // ---- acceptance 2: enable exposes tools, then connect ----------------
    const enabled = await mode.execute({ action: 'enable', connect: false }, exec)
    assert.equal(enabled.ok, true, JSON.stringify(enabled))
    assert.deepEqual([...tools.keys()].sort(), ['mc_companion_mode', ...GAME_TOOL_NAMES].sort())
    log(`PASS enable: ${GAME_TOOL_NAMES.length} gated tools registered`)

    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    assert.equal(connected.online, true)
    log(`PASS connect: ${connected.username} online as ${connected.version} at ${JSON.stringify(connected.position)}`)

    const gameMode = await until(() => companion.bot.bot?.game?.gameMode === 'creative', { label: 'creative game mode' })
    void gameMode
    log('PASS server sees a creative player')

    // ---- acceptance 3: follow only, no autonomy --------------------------
    const follow = await tools.get('mc_follow_player').execute({ action: 'start', player: 'Owner', radius: 2 }, exec)
    assert.equal(follow.ok, true, JSON.stringify(follow))
    const ownerPos = owner.entity.position
    server.write(`tp Owner ${Math.round(ownerPos.x + 10)} ${Math.round(ownerPos.y)} ${Math.round(ownerPos.z)}`)
    const followed = await until(
      () => {
        const comp = companion.bot.bot?.entity?.position
        const own = owner.entity?.position
        if (!comp || !own) return false
        return comp.distanceTo(own) <= 5
      },
      { timeoutMs: 25_000, label: 'companion to reach the owner' },
    )
    assert.equal(followed, true)
    log('PASS follow: companion walked to the teleported owner')

    // Chat round trip: owner -> bot event, bot -> owner chat event.
    const ownerHeard = waitFor(owner, 'chat', 10_000, 'owner hears companion chat')
    const chatResult = await tools.get('mc_chat').execute({ message: 'hello from DSH companion' }, exec)
    assert.equal(chatResult.ok, true, JSON.stringify(chatResult))
    const [heardName, heardMessage] = await ownerHeard
    assert.equal(heardName, 'Companion')
    assert.match(heardMessage, /hello from DSH companion/)
    owner.chat('hi companion, this is the owner')
    await until(
      () => companion.events.items.some((event) => event.type === 'chat' && event.data?.username === 'Owner'),
      { timeoutMs: 10_000, label: 'owner chat event' },
    )
    log('PASS chat: owner <-> companion messages relayed')

    // ---- acceptance 4: JSON -> schematic -> build ------------------------
    const spec = JSON.parse(await readFile(EXAMPLE, 'utf8'))
    const generated = await tools.get('mc_generate_schematic').execute({ spec, version: '1.20.4' }, exec)
    assert.equal(generated.ok, true, JSON.stringify(generated))
    await access(generated.path)
    assert.equal(generated.solidBlocks, 121)
    log(`PASS generate: ${generated.path} (${generated.bytes} bytes, ${generated.solidBlocks} blocks)`)

    // Build in a dedicated flat zone so repeated runs cannot collide with a
    // previous partial house. Following is stopped first so the bot stays put.
    await tools.get('mc_follow_player').execute({ action: 'stop' }, exec)
    server.write('tp Companion 40 -60 40')
    await until(
      () => companion.bot.bot?.entity?.position?.distanceTo(new Vec3(40, -60, 40)) < 2,
      { timeoutMs: 15_000, label: 'companion teleport' },
    )
    await companion.bot.bot.waitForChunksToLoad().catch(() => {})
    server.write('fill 36 -62 36 52 -52 52 air')
    await sleep(800)
    await companion.bot.bot.waitForChunksToLoad().catch(() => {})
    const groundY = findGround(companion.bot.bot, 43, 42)
    assert.ok(Number.isInteger(groundY), 'no ground under the build zone')
    const origin = { x: 43, y: groundY + 1, z: 42 }
    log(`build zone cleared, ground y=${groundY}, origin=${JSON.stringify(origin)}`)

    const dryRun = await tools.get('mc_build_schematic').execute(
      { schematic: 'small_house', position: origin, dry_run: true },
      exec,
    )
    assert.equal(dryRun.ok, true, JSON.stringify(dryRun))
    assert.equal(dryRun.plan.targetCount, 121)
    log(`PASS dry-run: 121 blocks, materials ${JSON.stringify(dryRun.plan.required)}`)

    const build = await tools.get('mc_build_schematic').execute(
      { schematic: 'small_house', position: origin, wait_ms: 60_000 },
      exec,
    )
    assert.equal(build.ok, true, JSON.stringify(build))
    const finished = await until(
      () => {
        const status = companion.build?.snapshot?.()
        if (!status) return false
        return status.status !== 'running' ? status : false
      },
      { timeoutMs: 90_000, intervalMs: 1_000, label: 'build to finish' },
    )
    assert.equal(finished.status, 'done', JSON.stringify(finished))
    assert.equal(finished.placed, 121, JSON.stringify(finished))
    assert.equal(finished.failed, 0, JSON.stringify(finished.errors))

    const blockAt = (dx, dy, dz) =>
      companion.bot.bot.blockAt(new Vec3(origin.x + dx, origin.y + dy, origin.z + dz))
    assert.equal(blockAt(0, 0, 0)?.name, 'oak_planks')
    assert.equal(blockAt(0, 1, 0)?.name, 'oak_log')
    assert.equal(blockAt(2, 1, 0)?.name, 'glass')
    assert.equal(blockAt(2, 1, 6)?.name, 'air')
    assert.equal(blockAt(3, 2, 3)?.name, 'glass')
    log('PASS build: 7x3x7 house reproduced and verified in the world')

    // ---- acceptance 5: missing materials are only reported ---------------
    server.write('gamemode survival Companion')
    server.write('clear Companion')
    await sleep(1_500)
    server.write('fill 52 -60 36 60 -52 48 air')
    await sleep(600)
    const missingGround = findGround(companion.bot.bot, 55, 42)
    assert.ok(Number.isInteger(missingGround), 'no ground under the missing-materials zone')
    const missingOrigin = { x: 55, y: missingGround + 1, z: 42 }
    const missing = await tools.get('mc_build_schematic').execute(
      { schematic: 'small_house', position: missingOrigin, dry_run: true },
      exec,
    )
    assert.equal(missing.ok, false, JSON.stringify(missing))
    assert.equal(missing.error, 'MISSING_MATERIALS')
    assert.ok(missing.missing.oak_planks)
    log(`PASS missing materials: reported ${JSON.stringify(missing.missing)} without placing`)
    server.write('gamemode creative Companion')
    await sleep(800)

    // ---- acceptance 6: disable cleans everything -------------------------
    const ownerSawLeave = waitFor(owner, 'playerLeft', 10_000, 'Companion to leave').catch(() => null)
    const disabled = await mode.execute({ action: 'disable', reason: 'e2e cleanup' }, exec)
    await ownerSawLeave
    assert.equal(disabled.ok, true, JSON.stringify(disabled))
    assert.deepEqual(disabled.cleaned, { tools: true, prompt: true, bot: true, timers: true, build: true })
    assert.deepEqual([...tools.keys()], ['mc_companion_mode'])
    assert.equal(companion.bot.bot, null)
    assert.equal(companion.bot.timers.size, 0)
    assert.equal(companion.bot.listeners.length, 0)
    assert.equal(companion.events.items.length, 1)
    assert.equal(companion.events.items[0].type, 'mode')
    const afterDisable = await tools.get('mc_status')
    assert.equal(afterDisable, undefined)
    log('PASS disable: tools unregistered, bot offline, timers/listeners cleared')

    console.log('\n=== E2E PASS ===')
  } finally {
    try {
      owner.quit('e2e done')
    } catch {
      /* ignore */
    }
    try {
      await mode.execute({ action: 'disable', reason: 'e2e finally' }, exec)
    } catch {
      /* ignore */
    }
    try {
      await ctx.dispose()
    } catch {
      /* ignore */
    }
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== E2E FAIL ===')
  console.error(error)
  process.exitCode = 1
})

