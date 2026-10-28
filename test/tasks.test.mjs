/**
 * Task stack + interrupt guards.
 *
 * A companion that cannot be interrupted is not a companion, it is a macro
 * runner. These tests pin the three behaviours that matter:
 *   - the stack knows what is running and why it stopped;
 *   - a behaviour pauses with its progress intact and resumes;
 *   - danger / distance / chat pause the innermost task exactly once.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Vec3 } from 'vec3'

import { install } from '../index.js'
import { BehaviorRunner } from '../lib/behaviors/runner.js'
import { EventLog } from '../lib/events.js'
import { normalizeConfig } from '../lib/config.js'
import { TaskStack } from '../lib/tasks.js'
import { createFakeCtx } from './helpers/fake-ctx.mjs'

// ---- task stack ----------------------------------------------------------

test('task stack: begin, update, end and snapshot', () => {
  const events = new EventLog(50)
  const stack = new TaskStack({ events })

  const behavior = stack.begin({ kind: 'behavior', id: 'run-1', label: '伐木 8 个' })
  assert.equal(stack.top().id, 'run-1')
  assert.equal(stack.snapshot().depth, 1)

  stack.update('run-1', { state: 'paused', note: 'low_health' })
  assert.equal(stack.top().state, 'paused')
  assert.equal(stack.snapshot().current.note, 'low_health')

  stack.end('run-1', 'done', '')
  assert.equal(stack.top(), null)
  assert.equal(stack.snapshot().depth, 0)
  assert.equal(stack.items[0].state, 'done')

  // Ending twice must not resurrect or double-report the task.
  stack.end('run-1', 'cancelled')
  assert.equal(stack.items[0].state, 'done')
  assert.equal(stack.items.length, 1)
})

test('task stack: unknown ids are ignored and history is bounded', () => {
  const stack = new TaskStack()
  assert.equal(stack.update('nope', { state: 'paused' }), null)
  assert.equal(stack.end('nope'), null)
  for (let i = 0; i < 30; i += 1) {
    stack.begin({ kind: 'behavior', label: `run ${i}` })
    stack.end(stack.top().id, 'done')
  }
  assert.ok(stack.items.length <= 20, `history should be trimmed, got ${stack.items.length}`)
})

// ---- behaviour pause / resume -------------------------------------------

function runnerHarness ({ health = 20 } = {}) {
  const botController = {
    bot: { entity: { position: new Vec3(0, 64, 0) }, health, pathfinder: { setGoal () {} } },
    pathfinder: null,
  }
  const runner = new BehaviorRunner({
    bot: botController,
    config: normalizeConfig({ behaviors: { woodcut: true } }),
    events: new EventLog(50),
  })
  // Inject an active run without loading a real behaviour module: we are
  // testing the pause/resume mechanics, not block selection.
  runner.active = {
    mode: 'woodcut',
    behavior: { label: '伐木', unit: '个原木' },
    instance: {},
    options: {},
    runId: 'woodcut-test',
    startedAt: Date.now() - 5_000,
    paused: false,
    pausedAt: 0,
    pausedMs: 0,
    pauseReason: '',
    progress: 3,
    target: 8,
    phase: 'chopping',
    note: '',
    failures: 0,
    timer: setTimeout(() => {}, 10_000),
    nextMilestone: Infinity,
  }
  return { runner, botController }
}

test('behaviour pause keeps progress, resume restarts the loop, stop reports paused', () => {
  const { runner } = runnerHarness()
  const paused = runner.pause('low_health')
  assert.equal(paused.paused, true)
  assert.equal(paused.pauseReason, 'low_health')
  assert.equal(paused.progress, 3)
  assert.equal(runner.active.timer, null, 'pausing must clear the step timer')

  const resumed = runner.resume()
  assert.equal(resumed.paused, false)
  assert.equal(resumed.progress, 3)
  assert.ok(runner.active.timer, 'resume must schedule the loop again')

  const summary = runner.stop('user request')
  assert.equal(summary.progress, 3)
  assert.equal(summary.paused, false)
  assert.ok(summary.elapsedMs < 6_000, 'paused time must not count as elapsed')
  clearTimeout(runner.active?.timer)
})

test('behaviour pause is idempotent and resume refuses an offline bot', () => {
  const { runner, botController } = runnerHarness()
  runner.pause('chat')
  const again = runner.pause('chat twice')
  assert.equal(again.pauseReason, 'chat', 'second pause must not overwrite the reason')

  botController.bot = null
  assert.throws(() => runner.resume(), /MC_BOT_OFFLINE/)
  assert.equal(runner.active.paused, true)

  const idle = new BehaviorRunner({ bot: botController, config: normalizeConfig({}), events: new EventLog(10) })
  assert.throws(() => idle.resume(), /MC_BEHAVIOR_NOT_PAUSED/)
})

// ---- companion interrupt guards -----------------------------------------

async function companionHarness ({ health = 20, follow = 'Owner', targetDistance = 2 } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-task-'))
  const { ctx } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false, behaviors: { woodcut: true } })
  await companion.enable({ connect: false })

  const bot = {
    version: '1.20.4',
    entity: { position: new Vec3(0, 64, 0) },
    health,
    food: 20,
    game: { dimension: 'overworld' },
    players: follow ? { [follow]: { entity: { position: new Vec3(targetDistance, 64, 0) } } } : {},
    entities: {},
    inventory: { items: () => [] },
  }
  companion.bot.bot = bot
  companion.bot.online = true
  companion.bot.follow = follow ? { player: follow, radius: 3 } : null

  const calls = []
  companion.behaviors = {
    pause: (reason) => {
      calls.push(['pause', reason])
      return { active: true, paused: true, progress: 3, target: 8 }
    },
    resume: () => ({ active: true, paused: false, progress: 3, target: 8 }),
    stop: () => ({ progress: 3 }),
    dispose: () => {},
    snapshot: () => ({ active: true, progress: 3, target: 8 }),
  }
  return { ctx, companion, calls }
}

test('guard: low health pauses the behaviour and records the reason', async () => {
  const { ctx, companion, calls } = await companionHarness({ health: 4 })
  companion.tasks.begin({ kind: 'behavior', id: 'run-1', label: '伐木' })

  const result = companion.checkInterrupts()
  assert.ok(result?.ok)
  assert.equal(result.reason, 'low_health')
  assert.deepEqual(calls[0], ['pause', 'low_health'])
  const task = companion.tasks.items[0]
  assert.equal(task.state, 'paused')
  assert.equal(task.note, '生命 4/20 已到安全下限')

  // A paused task is not interrupted twice by the same guard.
  assert.equal(companion.checkInterrupts(), null)
  await ctx.dispose()
})

test('guard: a player walking too far pauses, chat pauses, and each fires once', async () => {
  const { ctx, companion, calls } = await companionHarness({ targetDistance: 60 })
  companion.tasks.begin({ kind: 'behavior', id: 'run-2', label: '伐木' })
  const far = companion.checkInterrupts()
  assert.equal(far.reason, 'target_far')
  assert.match(far.note, /Owner 已在 60 格外/)

  companion.tasks.items[0].state = 'running' // simulate a resume for the chat guard
  companion.bot.bot.players.Owner.entity.position = new Vec3(2, 64, 0)
  companion.interrupts.lastChatSeq = companion.events.lastSeq
  companion.events.push('chat', 'Owner: 先别砍了')
  const chat = companion.checkInterrupts()
  assert.equal(chat.reason, 'player_chat')
  assert.equal(chat.note, 'Owner: 先别砍了')
  assert.equal(companion.checkInterrupts(), null, 'the same chat line must not interrupt twice')
  assert.equal(calls.length, 2)

  // Chat that arrives while paused is consumed, so resume() must not instantly
  // pause again on the same message.
  companion.events.push('chat', 'Owner: 还在吗')
  assert.equal(companion.checkInterrupts(), null)
  companion.tasks.items[0].state = 'running'
  assert.equal(companion.checkInterrupts(), null)
  assert.equal(calls.length, 2)
  await ctx.dispose()
})

test('guard: an interrupted build is cancelled and the stack records it', async () => {
  const { ctx, companion } = await companionHarness({ health: 2 })
  let cancelled = null
  companion.build = { status: 'running', cancel: (reason) => { cancelled = reason; return true } }
  companion.tasks.begin({ kind: 'build', id: 'build-1', label: '建造小房子' })

  const result = companion.checkInterrupts()
  assert.equal(result.reason, 'low_health')
  assert.equal(result.paused, false)
  assert.match(cancelled, /^interrupted: low_health/)
  assert.equal(companion.tasks.items[0].state, 'cancelled')
  await ctx.dispose()
})

test('stopping a behaviour closes its task through the onStop hook', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-hook-'))
  const { ctx } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false })
  await companion.enable({ connect: false })

  companion.tasks.begin({ kind: 'behavior', id: 'woodcut-manual', label: '伐木' })
  Object.assign(companion.behaviors, {
    active: {
      mode: 'woodcut',
      behavior: { label: '伐木', unit: '个原木' },
      instance: {},
      options: {},
      runId: 'woodcut-manual',
      startedAt: Date.now() - 1_000,
      paused: false,
      pausedAt: 0,
      pausedMs: 0,
      pauseReason: '',
      progress: 4,
      target: 8,
      phase: 'chopping',
      note: '',
      failures: 0,
      timer: null,
      nextMilestone: Infinity,
    },
  })
  companion.behaviors.stop('done')

  assert.equal(companion.tasks.items[0].state, 'done')
  assert.equal(companion.tasks.top(), null)
  await ctx.dispose()
})

test('tool: mc_behavior pause is harmless when idle, resume reports NOT_PAUSED', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-tool-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false })
  await companion.enable({ connect: false })

  const tool = tools.get('mc_behavior')
  const paused = await tool.execute({ action: 'pause', reason: 'test' }, {})
  assert.equal(paused.ok, true)
  assert.equal(paused.active, false)
  assert.equal(paused.action, 'pause')

  const resumed = await tool.execute({ action: 'resume' }, {})
  assert.equal(resumed.ok, false)
  assert.equal(resumed.error, 'MC_BEHAVIOR_NOT_PAUSED')
  await ctx.dispose()
})

test('disable clears the stack and stops the watchdog', async () => {
  const { ctx, companion } = await companionHarness()
  companion.tasks.begin({ kind: 'behavior', id: 'run-3', label: '伐木' })
  assert.ok(companion.interrupts.timer, 'watchdog runs while the mode is on')

  await companion.disable('test')
  assert.equal(companion.tasks.items.length, 0)
  assert.equal(companion.interrupts.timer, null)
  await ctx.dispose()
})
