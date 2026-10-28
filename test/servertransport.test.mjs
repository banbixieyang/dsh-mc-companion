import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ServerTransport, parseInventory, parseState } from '../lib/servertransport.js'

/** A fake RCON that records commands and answers from a table. */
function fakeClient (answers = {}) {
  const sent = []
  return {
    sent,
    async connect () { return this },
    async command (raw) {
      sent.push(raw)
      for (const [pattern, reply] of Object.entries(answers)) {
        if (new RegExp(pattern).test(raw)) return reply
      }
      return ''
    },
    close () {}
  }
}

const make = (answers) => {
  const client = fakeClient(answers)
  const events = { push () {} }
  const transport = new ServerTransport({ config: { server: { host: '127.0.0.1', port: 25575, password: 'x', botName: 'Bot' } }, events, client })
  return { transport, sent: client.sent }
}

test('dig runs the server-side mod command for the bot player', async () => {
  const { transport, sent } = make({ 'dshmc dig': 'dshmc: broke Oak Log at 10,64,3' })
  const result = await transport.dig(10, 64.7, 3.2)
  assert.equal(result.ok, true)
  assert.match(result.reply, /broke Oak Log/)
  assert.deepEqual(sent, ['dshmc dig Bot 10 64 3'])
})

test('a refusal from the mod is an error, not a silent success', async () => {
  const { transport } = make({ 'dshmc dig': 'dshmc: block is already air at 1,2,3' })
  const result = await transport.dig(1, 2, 3)
  assert.equal(result.ok, false)
  assert.match(result.reply, /already air/)
})

test('walk, place, look and count map to their commands', async () => {
  const { transport, sent } = make({
    'dshmc walk': 'dshmc: walked Bot to 5,64,5',
    'dshmc place': 'dshmc: placed minecraft:stone at 5,64,5',
    'dshmc look': 'dshmc: Bot looks at 5,64,5',
    'dshmc count': 'dshmc: count Bot iron_ingot = 3'
  })
  await transport.walk(5, 64, 5)
  await transport.place(5, 64, 5, 'minecraft:stone')
  await transport.look(5, 64, 5)
  const counted = await transport.count('iron_ingot')
  assert.equal(counted.count, 3)
  assert.deepEqual(sent, [
    'dshmc walk Bot 5 64 5',
    'dshmc place Bot 5 64 5 minecraft:stone',
    'dshmc look Bot 5 64 5',
    'dshmc count Bot iron_ingot'
  ])
})

test('spawn asks Carpet for a fake player', async () => {
  const { transport, sent } = make({ player: 'Spawned fake player Bot' })
  const result = await transport.spawn()
  assert.equal(result.ok, true)
  assert.deepEqual(sent, ['player Bot spawn'])
})

test('inventory and state replies are parsed', async () => {
  const { transport } = make({
    'dshmc inv': 'dshmc: inv Bot held=stone_pickaxe items=oak_planksx4,stickx2,cobblestonex12',
    'dshmc state': 'dshmc: state Bot pos=10,64,3 hp=20.0 food=18 mode=survival dim=minecraft:overworld'
  })
  const inventory = await transport.inventory()
  assert.equal(inventory.held, 'stone_pickaxe')
  assert.deepEqual(inventory.items, { oak_planks: 4, stick: 2, cobblestone: 12 })

  const state = await transport.state()
  assert.deepEqual(state.position, { x: 10, y: 64, z: 3 })
  assert.equal(state.health, 20)
  assert.equal(state.food, 18)
  assert.equal(state.gameMode, 'survival')
})

test('parsers tolerate empty replies', () => {
  assert.deepEqual(parseInventory(''), { held: null, items: {} })
  assert.equal(parseState('').position, null)
})
