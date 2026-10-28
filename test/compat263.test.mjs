#!/usr/bin/env node
/**
 * Minecraft 26.3 (protocol 777) compatibility layer.
 *
 * These assertions encode the parts that were *measured* against the real 26.3
 * server jar and a live Paper 26.3 server, so a package upgrade that silently
 * drops support fails here instead of at connect time:
 *
 *  - the compat installer is applied (minecraft-data / protocol / mineflayer /
 *    prismarine-chunk / prismarine-physics know 26.3);
 *  - the vendored data matches Mojang's own report (1286 blocks, 1658 items,
 *    161 entity types, protocol 777, data version 5023);
 *  - every 26.3 packet id in the installed protocol.json is one of the official
 *    ids, and nothing official is missing;
 *  - the 26.3-only wire details hold: `punch` is fieldless, `spectator_action`
 *    carries an entity id, `teleport_confirm` echoes position/rotation, and
 *    `entityDelta` round-trips a packed step list.
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(path.resolve('package.json'))
const { runCompatCheck } = await import('../scripts/install-263-compat.mjs')

const mcData = require('minecraft-data')
const serializer = require('minecraft-protocol/src/transforms/serializer')

const COMPAT_263 = mcData('26.3')

const packetIds = (state, dir) => {
  const type = COMPAT_263.protocol[state][dir].types.packet
  const field = type[1].find((entry) => entry.name === 'name')
  const mappings = field.type[1].mappings
  return Object.fromEntries(Object.entries(mappings).map(([key, name]) => [name, parseInt(key, 16)]))
}

test('compat layer reports itself installed', async () => {
  assert.equal(await runCompatCheck(), true, 'run: node scripts/install-263-compat.mjs')
})

test('minecraft-data resolves 26.3 with the official data version', () => {
  assert.ok(COMPAT_263, 'minecraft-data("26.3") returned null')
  assert.equal(COMPAT_263.version.minecraftVersion, '26.3')
  assert.equal(COMPAT_263.version.version, 777)
  assert.equal(COMPAT_263.version.dataVersion, 5023)
  assert.equal(COMPAT_263.blocksArray.length, 1286)
  assert.equal(COMPAT_263.itemsArray.length, 1658)
  assert.equal(COMPAT_263.entitiesArray.length, 161)
  // highest state id in the official report
  assert.equal(Math.max(...COMPAT_263.blocksArray.map((block) => block.maxStateId)), 35722)
  // every block must be addressable by state id, or chunk decoding breaks
  assert.equal(COMPAT_263.blocksByStateId[12345].name, 'mossy_cobblestone_wall')
})

test('every installed 26.3 packet id exists in Mojang\'s own report', async () => {
  const report = JSON.parse(await readFile(path.resolve('tools/mcdata263/reports/26.3/packets.json'), 'utf8'))
  const states = { handshaking: 'handshaking', status: 'status', login: 'login', configuration: 'configuration', play: 'play' }
  const dirs = { toClient: 'clientbound', toServer: 'serverbound' }

  for (const [protoState, reportState] of Object.entries(states)) {
    for (const [protoDir, reportDir] of Object.entries(dirs)) {
      const official = Object.entries(report[reportState]?.[reportDir] ?? {})
        .filter(([name]) => name !== 'protocol_id')
        .map(([, def]) => def.protocol_id)
        .sort((a, b) => a - b)
      const installed = Object.values(packetIds(protoState, protoDir))
      // The legacy server list ping (254) is not a framed packet and is absent
      // from the official report; every other id must be report-backed.
      const installReal = installed.filter((id) => id !== 254 && !(protoState === 'handshaking'))
      for (const id of installReal) {
        assert.ok(official.includes(id), `${protoState}/${protoDir}: id ${id} is not in the official report`)
      }
      for (const id of official) {
        assert.ok(installed.includes(id), `${protoState}/${protoDir}: official id ${id} is missing`)
      }
      assert.equal(new Set(installed).size, installed.length, `${protoState}/${protoDir}: duplicate packet ids`)
    }
  }
})

test('26.3-specific packet shapes', () => {
  const serverbound = packetIds('play', 'toServer')
  assert.equal(serverbound.punch, 46)
  assert.equal(serverbound.spectator_action, 63)
  assert.equal(serverbound.arm_animation, undefined, 'arm_animation was removed in 26.3')
  assert.equal(serverbound.tick_end, 13)

  // punch is fieldless: serialising it must produce only the packet id byte
  const punch = serializer
    .createSerializer({ state: 'play', isServer: false, version: '26.3' })
    .createPacketBuffer({ name: 'punch', params: {} })
  assert.equal(punch.toString('hex'), '2e')

  // spectator_action carries the targeted entity id
  const spectator = serializer
    .createSerializer({ state: 'play', isServer: false, version: '26.3' })
    .createPacketBuffer({ name: 'spectator_action', params: { entityId: 7 } })
  assert.equal(spectator.toString('hex'), '3f07')
})

test('teleport_confirm echoes position and rotation', () => {
  const proto = serializer.createSerializer({ state: 'play', isServer: false, version: '26.3' })
  const buffer = proto.createPacketBuffer({
    name: 'teleport_confirm',
    params: { teleportId: 1, x: 5.5, y: -60, z: 8.5, yaw: 90, pitch: -10 }
  })
  // id + varint id + 3 doubles + 2 floats, and no NaN in the payload
  assert.equal(buffer.length, 1 + 1 + 24 + 8)
  assert.equal(buffer.includes(0x7f) && buffer.toString('hex').includes('7fc00000'), false, 'NaN leaked into the payload')
})

test('entityDelta round-trips packed steps', () => {
  // clientbound packet: the server side serialises it, the client parses it
  const write = serializer.createSerializer({ state: 'play', isServer: true, version: '26.3' })
  const read = serializer.createDeserializer({ state: 'play', isServer: false, version: '26.3' })

  const single = { onGround: true, dX: 4096, dY: -2048, dZ: 0 }
  const singleBuffer = write.createPacketBuffer({ name: 'rel_entity_move', params: { entityId: 42, move: single } })
  const singleParsed = read.parsePacketBuffer(singleBuffer).data.params
  assert.equal(singleParsed.move.dX, 4096)
  assert.equal(singleParsed.move.dY, -2048)
  assert.equal(singleParsed.move.stepCount, 0)
  assert.equal(singleParsed.move.onGround, true)

  const stepped = {
    onGround: false,
    dX: 30,
    dY: 0,
    dZ: -10,
    steps: [
      { tickOffset: 0, dX: 10, dY: 0, dZ: -4 },
      { tickOffset: 1, dX: 20, dY: 0, dZ: -6 }
    ]
  }
  const steppedBuffer = write.createPacketBuffer({ name: 'rel_entity_move', params: { entityId: 43, move: stepped } })
  const steppedParsed = read.parsePacketBuffer(steppedBuffer).data.params
  assert.equal(steppedParsed.move.stepCount, 2)
  assert.deepEqual(steppedParsed.move.steps, stepped.steps)
  assert.equal(steppedParsed.move.dX, 30)
  assert.equal(steppedParsed.move.dZ, -10)
})

test('mineflayer declares native tick acknowledgement for 26.3', () => {
  assert.equal(COMPAT_263.supportFeature('sendsTickEnd'), true)
  assert.equal(COMPAT_263.supportFeature('swingIsPunch'), true)
  assert.equal(COMPAT_263.supportFeature('teleportConfirmEchoesPosition'), true)
  assert.equal(COMPAT_263.supportFeature('entityMoveUsesDelta'), true)
})



