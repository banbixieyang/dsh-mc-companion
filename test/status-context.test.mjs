/**
 * The live prompt context (`mc-companion-status`) is the companion's only
 * always-on sensor. These tests pin the two properties that make it cheap:
 *   - it is a compact summary, not the raw event stream;
 *   - unchanged facts and already-reported events are not sent again.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'

function fakeBot() {
  return {
    version: '1.20.4',
    entity: { position: { x: 10.5, y: 64, z: -3.2 } },
    health: 20,
    food: 18,
    game: { dimension: 'overworld', gameMode: 'survival' },
    players: {},
    entities: {
      2: { type: 'player', username: 'GloamRift', position: { x: 12, y: 64, z: -3 } },
      3: { type: 'mob', kind: 'Hostile mobs', name: 'zombie', position: { x: 15, y: 64, z: -3 } },
      4: { type: 'object', name: 'item', position: { x: 9, y: 64, z: -3 } },
      5: { type: 'player', username: 'FarAway', position: { x: 200, y: 64, z: -3 } },
    },
    inventory: {
      items: () => [
        { name: 'cobblestone', count: 32 },
        { name: 'oak_log', count: 3 },
      ],
    },
    heldItem: { name: 'iron_pickaxe', count: 1 },
    time: { timeOfDay: 6000 },
  }
}

async function enabledCompanion() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-status-'))
  const { ctx, contexts } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    autoConnect: false,
    host: '127.0.0.1',
    port: 25565,
    username: 'Tester',
  })
  const mode = (await import('../index.js')).install
  void mode
  await companion.enable({ connect: false })
  return { ctx, companion, contexts, text: () => contexts.get('mc-companion-status').text() }
}

test('offline: the context says the bot is not connected and stays short', async () => {
  const { ctx, contexts, text } = await enabledCompanion()
  const offline = text()
  assert.match(offline, /未连接/)
  assert.ok(offline.length < 240, `offline context too long: ${offline.length}`)
  assert.ok(contexts.size === 1)
  await ctx.dispose()
})

test('online: compact perception with position, hand, inventory and nearby entities', async () => {
  const { ctx, companion, text } = await enabledCompanion()
  companion.bot.bot = fakeBot()
  companion.bot.online = true

  const first = text()
  assert.match(first, /在线 1\.20\.4/)
  assert.match(first, /overworld/)
  assert.match(first, /\(10\.5, 64, -3\.2\)/)
  assert.match(first, /生命 20\/20/)
  assert.match(first, /主手 iron_pickaxe×1/)
  assert.match(first, /cobblestone×32/)
  assert.match(first, /玩家 GloamRift/)
  assert.match(first, /敌对 1/)
  assert.match(first, /掉落物 1/)
  assert.match(first, /未跟随玩家/)
  // 16 格以外的玩家不应进入摘要。
  assert.doesNotMatch(first, /FarAway/)
  await ctx.dispose()
})

test('delta: unchanged turns do not repeat facts, and events are sent exactly once', async () => {
  const { ctx, companion, text } = await enabledCompanion()
  companion.bot.bot = fakeBot()
  companion.bot.online = true

  const first = text()
  const second = text()
  assert.ok(second.length < first.length, `delta turn should shrink: ${first.length} -> ${second.length}`)
  assert.doesNotMatch(second, /背包/)
  assert.doesNotMatch(second, /附近/)

  companion.events.push('chat', 'GloamRift: 你在哪')
  const third = text()
  assert.match(third, /新事件/)
  assert.match(third, /GloamRift: 你在哪/)

  const fourth = text()
  assert.doesNotMatch(fourth, /GloamRift: 你在哪/, 'the same chat line must not be re-sent')
  await ctx.dispose()
})

test('changes: new inventory stacks and health changes show up immediately', async () => {
  const { ctx, companion, text } = await enabledCompanion()
  const bot = fakeBot()
  companion.bot.bot = bot
  companion.bot.online = true
  text()

  bot.inventory.items = () => [
    { name: 'cobblestone', count: 32 },
    { name: 'oak_log', count: 3 },
    { name: 'iron_ore', count: 2 },
  ]
  bot.health = 14
  const after = text()
  assert.match(after, /iron_ore×2/)
  assert.match(after, /生命 14\/20/)
  await ctx.dispose()
})
