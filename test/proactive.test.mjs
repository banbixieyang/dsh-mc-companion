/**
 * Proactivity: the hardest thing to get right is restraint.
 *
 * These tests pin the brakes (cooldown, quiet, disabled, first-tick baseline)
 * before the features: one line per window, never on the first tick, never when
 * silenced, and no speech unless explicitly enabled.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { isNight, ProactiveWatcher } from '../lib/proactive.js'
import { normalizeConfig } from '../lib/config.js'
import { EventLog } from '../lib/events.js'
import { attachBot, fakeBot, makeCompanion, pos } from './eval/helpers.mjs'

function watcher(proactive = {}) {
  const config = normalizeConfig({ proactive })
  return { watcher: new ProactiveWatcher({ config }), events: new EventLog(50) }
}

function botWith({ health = 20, timeOfDay = 6000 } = {}) {
  const bot = fakeBot({ health })
  bot.time = { timeOfDay }
  return bot
}

test('isNight: 13000–23000, wrapping negative and >24000 ticks', () => {
  assert.equal(isNight(0), false)
  assert.equal(isNight(12000), false)
  assert.equal(isNight(13000), true)
  assert.equal(isNight(18000), true)
  assert.equal(isNight(23000), true)
  assert.equal(isNight(23500), false)
  assert.equal(isNight(24000 + 14000), true)
  assert.equal(isNight(-10000), true)
  assert.equal(isNight(undefined), false)
})

test('first tick only establishes a baseline (no announcement on enable)', () => {
  const { watcher: w } = watcher()
  const bot = botWith({ health: 4, timeOfDay: 18000 })
  assert.equal(w.observe({ bot, events: null }), null)
  // The next tick may react to what changed *after* the baseline.
  assert.equal(w.observe({ bot, events: null })?.kind, undefined)
})

test('hurt: fires once, then cooldown suppresses the next event', () => {
  const { watcher: w, events } = watcher({ cooldownMs: 120_000 })
  const bot = botWith({ health: 20 })
  w.observe({ bot, events })
  bot.health = 14
  const first = w.observe({ bot, events })
  assert.equal(first.kind, 'hurt')
  assert.match(first.text, /你受伤了（生命 14\/20）/)

  bot.health = 8
  assert.equal(w.observe({ bot, events }), null, 'cooldown must swallow the second event')
})

test('low health fires when crossing the threshold, not on every tick', () => {
  const { watcher: w, events } = watcher()
  const bot = botWith({ health: 20 })
  w.observe({ bot, events })
  bot.health = 5
  const first = w.observe({ bot, events })
  assert.equal(first.kind, 'low_health')
  assert.match(first.text, /血量低了/)

  // Still low, but no new crossing → no repeat.
  w.lastAt = 0
  assert.equal(w.observe({ bot, events }), null)
})

test('night falls once per night, and only on the transition', () => {
  const { watcher: w, events } = watcher()
  const bot = botWith({ timeOfDay: 10_000 })
  w.observe({ bot, events })
  bot.time.timeOfDay = 14_000
  assert.equal(w.observe({ bot, events }).kind, 'night')
  w.lastAt = 0
  assert.equal(w.observe({ bot, events }), null)
})

test('arrives: fires when the player gets close after being far', () => {
  const { watcher: w, events } = watcher({ nearDistance: 8 })
  const bot = botWith()
  w.observe({ bot, events, followDistance: 30 })
  const near = w.observe({ bot, events, followDistance: 4 })
  assert.equal(near.kind, 'arrived')
  w.lastAt = 0
  assert.equal(w.observe({ bot, events, followDistance: 3 }), null)
})

test('task_done fires when a behaviour finishes successfully', () => {
  const { watcher: w, events } = watcher()
  const bot = botWith()
  w.observe({ bot, events, behavior: { active: true } })
  const done = w.observe({
    bot,
    events,
    behavior: { active: false, last: { reason: 'done', progress: 16, target: 16, unit: '个原木' } },
  })
  assert.equal(done.kind, 'task_done')
  assert.match(done.text, /16\/16 个原木/)
})

test('quiet and disabled both mean silence; baselines still advance', () => {
  const { watcher: w, events } = watcher()
  const bot = botWith({ health: 20 })
  w.observe({ bot, events })
  w.setQuiet(true)
  bot.health = 10
  assert.equal(w.observe({ bot, events }), null, 'quiet suppresses')
  w.setQuiet(false)
  bot.health = 6
  const after = w.observe({ bot, events })
  assert.equal(after?.kind, 'low_health', 'only the new crossing fires after unmuting')
  assert.doesNotMatch(after.text, /受伤/, 'the event missed during quiet is not replayed')

  const off = watcher({ enabled: false }).watcher
  off.observe({ bot: botWith(), events: null })
  assert.equal(off.observe({ bot: botWith({ health: 4 }), events: null }), null)
})

test('companion: suggestion shows in the prompt and stays silent by default', async () => {
  const { ctx, companion, text } = await makeCompanion()
  const bot = fakeBot({ health: 20 })
  const said = []
  bot.chat = (message) => said.push(message)
  attachBot(companion, bot)

  companion.tickProactive() // baseline
  bot.health = 10
  const suggestion = companion.tickProactive()
  assert.equal(suggestion.kind, 'hurt')
  assert.match(text(), /建议主动：你受伤了/)
  assert.deepEqual(said, [], 'speak defaults to false: the model decides, not the plugin')
  await ctx.dispose()
})

test('companion: speak=true says one line, quiet stops it', async () => {
  const { ctx, companion } = await makeCompanion({ config: { proactive: { speak: true } } })
  const bot = fakeBot({ health: 20 })
  const said = []
  bot.chat = (message) => said.push(message)
  attachBot(companion, bot)

  companion.tickProactive()
  bot.health = 10
  companion.tickProactive()
  assert.equal(said.length, 1)
  assert.match(said[0], /你受伤了/)

  companion.setQuiet(true)
  bot.health = 3
  companion.tickProactive()
  assert.equal(said.length, 1, 'quiet must stop autonomous speech')
  await ctx.dispose()
})

test('companion: quiet hides an already pending suggestion', async () => {
  const { ctx, companion, text } = await makeCompanion()
  const bot = fakeBot({ health: 20 })
  attachBot(companion, bot)
  companion.tickProactive()
  bot.health = 11
  companion.tickProactive()
  assert.match(text(), /建议主动：/)

  await companion.setQuiet(true)
  assert.doesNotMatch(text(), /建议主动/, 'quiet must silence the prompt, not just new events')
  await companion.setQuiet(false)
  assert.match(text(), /建议主动：/, 'unmuting shows the still-fresh suggestion again')
  await ctx.dispose()
})

test('companion: mc_presence toggles quiet and reports policy', async () => {
  const { ctx, tools } = await makeCompanion()
  const tool = tools.get('mc_presence')
  assert.ok(tool)

  const quiet = await tool.execute({ action: 'quiet' }, {})
  assert.equal(quiet.ok, true)
  assert.equal(quiet.quiet, true)

  const status = await tool.execute({ action: 'status' }, {})
  assert.equal(status.quiet, true)
  assert.equal(status.speak, false)

  const normal = await tool.execute({ action: 'normal' }, {})
  assert.equal(normal.quiet, false)
  await ctx.dispose()
})

test('companion: proactive tick needs an online bot', async () => {
  const { ctx, companion } = await makeCompanion()
  assert.equal(companion.tickProactive(), null)
  await ctx.dispose()
})

test('position helper keeps distances finite for the guard', () => {
  const a = pos(0, 64, 0)
  assert.equal(Math.round(a.distanceTo(pos(3, 64, 4))), 5)
})
