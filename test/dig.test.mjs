import { test } from 'node:test'
import assert from 'node:assert/strict'

import { digBlock } from '../lib/behaviors/helpers.js'

const pos = (x, y, z) => ({ x, y, z, distanceTo: (o) => Math.hypot(x - o.x, y - o.y, z - o.z), offset: (dx, dy, dz) => pos(x + dx, y + dy, z + dz) })

/** A bot whose dig() marks the block air locally, like mineflayer does. */
function digBot ({ serverAccepts = true, dropAppears = false } = {}) {
  const state = { blockName: 'oak_log', digCalls: 0, entities: {} }
  const bot = {
    entity: { position: pos(0, -60, 0) },
    entities: {},
    blockAt: () => ({ name: state.blockName, position: pos(1, -60, 0) }),
    canDigBlock: () => true,
    dig: async () => {
      state.digCalls += 1
      // mineflayer sets the block to air locally no matter what the server did
      state.blockName = 'air'
      if (dropAppears) bot.entities[99] = { id: 99, name: 'item', position: pos(1.2, -60, 0.2) }
    },
    stopDigging: () => {},
    _serverBlockChangeAt: () => serverAccepts
  }
  return { bot, state }
}

test('a server-confirmed dig counts as success', async () => {
  const { bot } = digBot({ serverAccepts: true })
  const block = { name: 'oak_log', position: pos(1, -60, 0) }
  const result = await digBlock(bot, null, block, {})
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('a dig the server ignores is rejected even though the client shows air', async () => {
  const { bot, state } = digBot({ serverAccepts: false })
  const block = { name: 'oak_log', position: pos(1, -60, 0) }
  const result = await digBlock(bot, null, block, { digTimeoutMs: 2_000 })
  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.reason, 'dig_rejected')
  assert.ok(state.digCalls >= 1, 'it should try')
})

test('an item drop is accepted as proof of the break', async () => {
  const { bot } = digBot({ serverAccepts: false, dropAppears: true })
  const block = { name: 'oak_log', position: pos(1, -60, 0) }
  const result = await digBlock(bot, null, block, {})
  assert.equal(result.ok, true, JSON.stringify(result))
})

test('a block that cannot be dug is refused without digging', async () => {
  const { bot, state } = digBot()
  bot.canDigBlock = () => false
  const block = { name: 'bedrock', position: pos(1, -60, 0) }
  const result = await digBlock(bot, null, block, {})
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cannot_dig')
  assert.equal(state.digCalls, 0)
})
