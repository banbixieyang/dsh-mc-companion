import assert from 'node:assert/strict'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { GAME_TOOL_NAMES, install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'

async function freshWorkspace() {
  return mkdtemp(path.join(tmpdir(), 'mc-companion-gate-'))
}

test('load-time: only mc_companion_mode is registered, zero Minecraft side effects', async () => {
  const cwd = await freshWorkspace()
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: 25565,
    username: 'Tester',
    autoConnect: false,
    schematicVersion: '1.20.4',
  })

  assert.deepEqual([...tools.keys()], ['mc_companion_mode'])
  assert.equal(companion.isEnabled(), false)
  assert.equal(companion.bot.bot, null)
  assert.equal(companion.bot.mineflayerLoaded, false)
  assert.equal(companion.bot.timers.size, 0)
  assert.equal(companion.bot.listeners.length, 0)
  assert.equal(companion.events.items.length, 0)
  assert.equal(companion.promptDisposers.length, 0)
  // No schematic directory is created or read while the mode is off.
  assert.deepEqual(await readdir(cwd), [])

  const status = await tools.get('mc_companion_mode').execute({ action: 'status' }, execContext())
  assert.equal(status.ok, true)
  assert.equal(status.enabled, false)
  assert.deepEqual(status.tools, [])

  await ctx.dispose()
  assert.deepEqual([...tools.keys()], [])
})

test('enable exposes exactly the game tools; disable removes them and cleans up', async () => {
  const cwd = await freshWorkspace()
  const { ctx, tools, sections, contexts, disposedTools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    autoConnect: false,
    host: '127.0.0.1',
    port: 25565,
    username: 'Tester',
  })
  const mode = tools.get('mc_companion_mode')
  const exec = execContext()

  const enabled = await mode.execute({ action: 'enable', connect: false }, exec)
  assert.equal(enabled.ok, true, JSON.stringify(enabled))
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.connected, false)
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['mc_companion_mode', ...GAME_TOOL_NAMES].sort(),
  )
  assert.equal(companion.bot.bot, null)
  assert.equal(companion.bot.mineflayerLoaded, false)
  assert.equal(sections.size, 1)
  assert.equal(contexts.size, 1)
  assert.match(contexts.get('mc-companion-status').text(), /未连接/)

  const alive = await tools.get('mc_status').execute({}, exec)
  assert.equal(alive.ok, true)
  assert.equal(alive.enabled, true)

  const disabled = await mode.execute({ action: 'disable', reason: 'test cleanup' }, exec)
  assert.equal(disabled.ok, true)
  assert.equal(disabled.enabled, false)
  assert.deepEqual(disabled.tools, [])
  assert.deepEqual(disabled.cleaned, {
    tools: true,
    prompt: true,
    bot: true,
    timers: true,
    build: true,
  })
  assert.deepEqual([...tools.keys()], ['mc_companion_mode'])
  assert.equal(sections.size, 0)
  assert.equal(contexts.size, 0)
  assert.equal(companion.bot.bot, null)
  assert.equal(companion.bot.timers.size, 0)
  assert.ok(disposedTools.includes('mc_status'))
  assert.ok(disposedTools.includes('mc_build_schematic'))
  // Nothing from the game survives; the mode event is all that remains.
  assert.equal(companion.events.items.length, 1)
  assert.equal(companion.events.items[0].type, 'mode')

  const reEnabled = await mode.execute({ action: 'enable', connect: false }, exec)
  assert.equal(reEnabled.ok, true)
  assert.deepEqual(
    [...tools.keys()].sort(),
    ['mc_companion_mode', ...GAME_TOOL_NAMES].sort(),
  )
  await mode.execute({ action: 'disable', reason: 'test done' }, exec)
  assert.deepEqual([...tools.keys()], ['mc_companion_mode'])
  await ctx.dispose()
})

test('a stale gated tool refuses with MC_COMPANION_MODE_DISABLED and has no side effects', async () => {
  const cwd = await freshWorkspace()
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false })
  const mode = tools.get('mc_companion_mode')
  const exec = execContext()

  await mode.execute({ action: 'enable', connect: false }, exec)
  // Capture the definition, then disable: this is exactly the stale-dispatch
  // window the first-line gate exists for.
  const staleStatus = tools.get('mc_status')
  const staleBuild = tools.get('mc_build_schematic')
  await mode.execute({ action: 'disable', reason: 'stale test' }, exec)

  for (const definition of [staleStatus, staleBuild]) {
    const result = await definition.execute({ schematic: 'x' }, exec)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'MC_COMPANION_MODE_DISABLED')
  }
  assert.equal(companion.bot.bot, null)
  assert.equal(companion.events.items.length, 1)
  await ctx.dispose()
})

test('enable with connect:true reports a connect failure without crashing the mode', async () => {
  const cwd = await freshWorkspace()
  const { ctx, tools } = createFakeCtx({ cwd })
  // Port 1 is closed: the connect must fail fast and keep the mode enabled.
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: 1,
    username: 'Tester',
    autoConnect: true,
    connectTimeoutMs: 3_000,
  })
  const mode = tools.get('mc_companion_mode')
  const result = await mode.execute({ action: 'enable' }, execContext())
  assert.equal(result.ok, false)
  assert.equal(result.error, 'MC_CONNECT_FAILED')
  assert.equal(result.enabled, true)
  assert.equal(companion.isEnabled(), true)
  assert.ok(tools.get('mc_status'))
  assert.equal(companion.bot.bot, null)
  await mode.execute({ action: 'disable', reason: 'test' }, execContext())
  await ctx.dispose()
})

test('mc_companion_mode rejects unknown actions', async () => {
  const cwd = await freshWorkspace()
  const { ctx, tools } = createFakeCtx({ cwd })
  install(ctx, { autoConnect: false })
  const mode = tools.get('mc_companion_mode')
  const result = await mode.execute({ action: 'launch' }, execContext())
  assert.equal(result.ok, false)
  assert.equal(result.error, 'MC_MODE_BAD_ACTION')
  await ctx.dispose()
})
