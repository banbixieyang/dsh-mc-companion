#!/usr/bin/env node
/**
 * Install native Minecraft 26.3 (protocol 777) support into the Minecraft
 * JavaScript stack.
 *
 * Why this exists: no released PrismarineJS package speaks 26.3. minecraft-data
 * publishes no 26.3 payload, node-minecraft-protocol's `supportedVersions` ends
 * at 26.1, prismarine-chunk has no 26.x chunk dispatch beyond 26.1, and
 * mineflayer does not list the version. The upstream work exists but is
 * unreleased, so the data set is vendored under `vendor/mc-data-26.3`
 * (provenance in `vendor/NOTICE.md`) and this script wires it in.
 *
 * Usage:
 *   node scripts/install-263-compat.mjs          # apply (idempotent)
 *   node scripts/install-263-compat.mjs --check  # verify only, exit 1 if incomplete
 *
 * Every patch is guarded, so this is safe to re-run — including after
 * `npm install`, which is why package.json runs it on postinstall.
 */
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const VENDOR = path.join(ROOT, 'vendor', 'mc-data-26.3')
const VERSION = '26.3'
const PROTOCOL = 777
const DATA_VERSION = 5023

const require = createRequire(path.join(ROOT, 'package.json'))
const pkgDir = (id) => path.dirname(require.resolve(`${id}/package.json`))

// Slice of the 26.1 data that has no 26.3 equivalent we can generate: cosmetic
// tables and loot/command data that did not change shape. Reusing the 26.1 file
// is what upstream does for other versions too.
const REUSE_261 = {
  attributes: 'pc/26.1/attributes.json',
  biomes: 'pc/26.1/biomes.json',
  effects: 'pc/26.1/effects.json',
  enchantments: 'pc/26.1/enchantments.json',
  entityLoot: 'pc/1.20/entityLoot.json',
  instruments: 'pc/26.1/instruments.json',
  language: 'pc/26.1/language.json',
  loginPacket: 'pc/26.1/loginPacket.json',
  mapIcons: 'pc/1.20.2/mapIcons.json',
  materials: 'pc/26.1/materials.json',
  particles: 'pc/26.1/particles.json',
  sounds: 'pc/26.1/sounds.json',
  tints: 'pc/26.1/tints.json',
  windows: 'pc/1.16.1/windows.json'
}

/**
 * 26.3 protocol corrections that the vendored data either lacks or carries over
 * from 26.1:
 *  - serverbound 0x2e `punch` replaced `swing` and has **no fields** (26.1's
 *    `arm_animation` sent a hand), so mineflayer's swing has to be rewritten;
 *  - serverbound 0x3f is `spectator_action` (entity id), not `arm_animation`.
 * Source: https://minecraft.wiki/w/Java_Edition_protocol/Packets (protocol 777).
 */
export function fixProtocol263(protocol) {
  const serverbound = protocol.play.toServer.types
  const packetType = serverbound.packet
  const mappings = packetType[1].find((f) => f.name === 'name').type[1].mappings
  const params = packetType[1].find((f) => f.name === 'params').type[1].fields

  for (const [id, name] of Object.entries(mappings)) {
    if (name === 'arm_animation') {
      mappings[id] = 'spectator_action'
      delete params.arm_animation
      params.spectator_action = 'packet_spectator_action'
      delete serverbound.packet_arm_animation
      serverbound.packet_spectator_action = ['container', [{ name: 'entityId', type: 'varint' }]]
    }
  }
  if (Object.values(mappings).includes('punch')) {
    params.punch = 'packet_punch'
    serverbound.packet_punch = 'void'
  }

  // 26.3's Confirm Teleportation echoes the resulting position and rotation. The
  // vendored data names the last two fields yRot/xRot; use plain names so the
  // mineflayer patch below reads the same way as the rest of the stack.
  const confirm = serverbound.packet_teleport_confirm
  if (confirm) {
    for (const field of confirm[1]) {
      if (field.name === 'yRot') field.name = 'yaw'
      if (field.name === 'xRot') field.name = 'pitch'
    }
  }
  return protocol
}

/** Read a file, returning null when it is absent. */
const readOrNull = (file) => readFile(file, 'utf8').catch(() => null)

/**
 * The exact file bodies that belong in minecraft-data, keyed by file name.
 * Checks compare against these, so a change here can never be silently skipped.
 */
async function expectedDataFiles() {
  const out = {}
  for (const file of ['version.json', 'blocks.json', 'items.json', 'entities.json', 'blockCollisionShapes.json', 'foods.json', 'recipes.json']) {
    out[file] = await readFile(path.join(VENDOR, file), 'utf8')
  }
  out['protocol.json'] = JSON.stringify(fixProtocol263(JSON.parse(await readFile(path.join(VENDOR, 'protocol.json'), 'utf8'))), null, 2) + '\n'
  return out
}

// ---------------------------------------------------------------------------
// Patch table: each entry knows how to check itself and how to apply.
// ---------------------------------------------------------------------------
const ENTITY_DELTA_SOURCE = `'use strict'

/**
 * 26.3 packed entity movement delta (VecDelta).
 *
 * Wire format, straight from ClientboundMoveEntityPacket / VecDelta:
 *   varint properties  — bit 0: onGround, bits 1..: step count
 *   step count 0      — one i16 triplet with 12 fractional bits
 *   step count n      — n x { varint tickOffset, i16 dX, i16 dY, i16 dZ }
 *
 * The returned value exposes the summed delta in dX/dY/dZ, so consumers do not
 * have to walk the step list, plus the steps themselves for interpolation.
 */
const [readVarInt, writeVarInt, sizeOfVarInt] = require('protodef').types.varint
const { PartialReadError } = require('protodef').utils

function readEntityDelta (buffer, offset) {
  let cursor = offset
  const properties = readVarInt(buffer, cursor)
  cursor += properties.size
  const onGround = (properties.value & 1) === 1
  const stepCount = properties.value >>> 1
  const steps = []
  let dX = 0
  let dY = 0
  let dZ = 0
  if (stepCount === 0) {
    if (cursor + 6 > buffer.length) throw new PartialReadError()
    dX = buffer.readInt16BE(cursor)
    dY = buffer.readInt16BE(cursor + 2)
    dZ = buffer.readInt16BE(cursor + 4)
    cursor += 6
  } else {
    for (let i = 0; i < stepCount; i++) {
      const tickOffset = readVarInt(buffer, cursor)
      cursor += tickOffset.size
      if (cursor + 6 > buffer.length) throw new PartialReadError()
      const sx = buffer.readInt16BE(cursor)
      const sy = buffer.readInt16BE(cursor + 2)
      const sz = buffer.readInt16BE(cursor + 4)
      cursor += 6
      steps.push({ tickOffset: tickOffset.value, dX: sx, dY: sy, dZ: sz })
      dX += sx
      dY += sy
      dZ += sz
    }
  }
  return { value: { onGround, stepCount, dX, dY, dZ, steps }, size: cursor - offset }
}

function writeEntityDelta (value, buffer, offset) {
  const steps = value.steps ?? []
  const properties = (steps.length << 1) | (value.onGround ? 1 : 0)
  let cursor = writeVarInt(properties, buffer, offset)
  if (steps.length === 0) {
    buffer.writeInt16BE(value.dX ?? 0, cursor)
    buffer.writeInt16BE(value.dY ?? 0, cursor + 2)
    buffer.writeInt16BE(value.dZ ?? 0, cursor + 4)
    return cursor + 6
  }
  for (const step of steps) {
    cursor = writeVarInt(step.tickOffset ?? 0, buffer, cursor)
    buffer.writeInt16BE(step.dX ?? 0, cursor)
    buffer.writeInt16BE(step.dY ?? 0, cursor + 2)
    buffer.writeInt16BE(step.dZ ?? 0, cursor + 4)
    cursor += 6
  }
  return cursor
}

function sizeOfEntityDelta (value) {
  const steps = value.steps ?? []
  let size = sizeOfVarInt((steps.length << 1) | (value.onGround ? 1 : 0))
  if (steps.length === 0) return size + 6
  for (const step of steps) size += sizeOfVarInt(step.tickOffset ?? 0) + 6
  return size
}

module.exports = [readEntityDelta, writeEntityDelta, sizeOfEntityDelta]
`

const patches = [
  {
    name: 'minecraft-data data/pc/26.3',
    async check() {
      const dir = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', VERSION)
      const expected = await expectedDataFiles()
      for (const [file, body] of Object.entries(expected)) {
        if ((await readOrNull(path.join(dir, file))) !== body) return false
      }
      return true
    },
    async apply() {
      const dir = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', VERSION)
      await mkdir(dir, { recursive: true })
      for (const [file, body] of Object.entries(await expectedDataFiles())) {
        await writeFile(path.join(dir, file), body)
      }
      return true
    }
  },
  {
    name: 'minecraft-data data.js',
    file: () => path.join(pkgDir('minecraft-data'), 'data.js'),
    check: async (src) => src.includes(`'${VERSION}': {`),
    transform(src) {
      const fields = {}
      for (const key of ['blocks', 'items', 'entities', 'blockCollisionShapes', 'foods', 'recipes', 'protocol', 'version']) {
        fields[key] = `pc/${VERSION}/${key}.json`
      }
      const lines = [`    '${VERSION}': {`]
      for (const [key, rel] of Object.entries({ ...REUSE_261, ...fields }).sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`      get ${key} () { return require("./minecraft-data/data/${rel}") },`)
      }
      lines.push("      proto: __dirname + '/minecraft-data/data/pc/latest/proto.yml'")
      lines.push('    },')
      const at = src.indexOf("    '26.1': {")
      if (at < 0) throw new Error('data.js: pc 26.1 anchor not found')
      return src.slice(0, at) + lines.join('\n') + '\n' + src.slice(at)
    }
  },
  {
    name: 'minecraft-data dataPaths.json',
    async check() {
      const json = JSON.parse((await readOrNull(path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'dataPaths.json'))) ?? '{}')
      return Boolean(json.pc?.[VERSION])
    },
    async apply() {
      const file = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'dataPaths.json')
      const json = JSON.parse(await readFile(file, 'utf8'))
      const entry = { ...json.pc['26.1'] }
      for (const key of ['blocks', 'items', 'entities', 'blockCollisionShapes', 'foods', 'recipes', 'protocol', 'version']) entry[key] = `pc/${VERSION}`
      json.pc[VERSION] = entry
      await writeFile(file, JSON.stringify(json, null, 1) + '\n')
      return true
    }
  },
  {
    name: 'minecraft-data versions.json',
    async check() {
      const list = JSON.parse((await readOrNull(path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'versions.json'))) ?? '[]')
      return list.includes(VERSION)
    },
    async apply() {
      const file = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'versions.json')
      const list = JSON.parse(await readFile(file, 'utf8'))
      list.push(VERSION)
      await writeFile(file, JSON.stringify(list) + '\n')
      return true
    }
  },
  {
    name: 'minecraft-data features.json (swingIsPunch)',
    async check() {
      const list = JSON.parse((await readOrNull(path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json'))) ?? '[]')
      return list.some((f) => f.name === 'swingIsPunch')
    },
    async apply() {
      const file = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json')
      const list = JSON.parse(await readFile(file, 'utf8'))
      list.push({
        name: 'swingIsPunch',
        description: 'arm swing uses the fieldless `punch` packet instead of `arm_animation`',
        versions: [VERSION, 'latest']
      })
      await writeFile(file, JSON.stringify(list, null, 2) + '\n')
      return true
    }
  },
  {
    name: 'minecraft-protocol supportedVersions',
    file: () => path.join(pkgDir('minecraft-protocol'), 'src', 'version.js'),
    check: async (src) => /supportedVersions: \[[^\]]*'26\.3'/.test(src),
    transform: (src) => src.replace(/(supportedVersions: \[[^\]]*?)('26\.1')\]/, `$1$2, '${VERSION}']`)
  },
  {
    name: 'mineflayer testedVersions',
    file: () => path.join(pkgDir('mineflayer'), 'lib', 'version.js'),
    check: async (src) => /testedVersions = \[[^\]]*'26\.3'/.test(src),
    transform: (src) => src.replace(/(testedVersions = \[[^\]]*?)('26\.1')\]/, `$1$2, '${VERSION}']`)
  },
  {
    name: 'mineflayer swingArm -> punch',
    file: () => path.join(pkgDir('mineflayer'), 'lib', 'plugins', 'entities.js'),
    check: async (src) => src.includes("write('punch'"),
    transform(src) {
      const anchor = "    bot._client.write('arm_animation', packet)"
      if (!src.includes(anchor)) throw new Error('mineflayer entities.js: swingArm write site not found')
      return src.replace(
        anchor,
        "    if (bot.supportFeature('swingIsPunch')) {\n      bot._client.write('punch', {})\n    } else {\n      bot._client.write('arm_animation', packet)\n    }"
      )
    }
  },
  {
    name: 'prismarine-chunk 26.3 dispatch',
    file: () => path.join(pkgDir('prismarine-chunk'), 'src', 'index.js'),
    check: async (src) => /^\s*'?26\.3'?:\s*require/m.test(src),
    transform: (src) =>
      src.replace(/(\n\s*'?26\.1'?:\s*require\('\.\/pc\/1\.18\/chunk'\))/, `$1,\n    '${VERSION}': require('./pc/1.18/chunk')`)
  },
  {
    name: 'minecraft-data features.json (sendsTickEnd)',
    async check() {
      const list = JSON.parse((await readOrNull(path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json'))) ?? '[]')
      return list.some((f) => f.name === 'sendsTickEnd')
    },
    async apply() {
      const file = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json')
      const list = JSON.parse(await readFile(file, 'utf8'))
      list.push({
        name: 'sendsTickEnd',
        description: 'client acknowledges every simulated tick with a serverbound tick_end packet',
        versions: ['1.21.3', 'latest']
      })
      await writeFile(file, JSON.stringify(list, null, 2) + '\n')
      return true
    }
  },
  {
    // 26.3's ServerGamePacketListenerImpl#handleMovePlayer disconnects a client
    // that sends two position packets inside one server tick ("Invalid move
    // player packet received"), and #handleClientTickEnd is what clears that
    // state. Vanilla therefore sends tick_end once per tick, after its movement.
    // mineflayer's physics loop can emit several movement packets per tick
    // (catch-up ticks, the forced spawn position), so acknowledge every write.
    name: 'mineflayer acknowledges movement with tick_end',
    file: () => path.join(pkgDir('mineflayer'), 'lib', 'plugins', 'physics.js'),
    check: async (src) => src.includes('function writeMovement'),
    transform(src) {
      const featureAnchor = "  const hasConfigurationState = bot.supportFeature('hasConfigurationState') // 1.20.2+"
      if (!src.includes(featureAnchor)) throw new Error('mineflayer physics.js: feature anchor not found')
      const writes = [
        ["bot._client.write('position', lastSent)", "writeMovement('position', lastSent)"],
        ["bot._client.write('look', lastSent)", "writeMovement('look', lastSent)"],
        ["bot._client.write('position_look', lastSent)", "writeMovement('position_look', lastSent)"],
        ["bot._client.write('flying', {", "writeMovement('flying', {"]
      ]
      let out = src
      for (const [from, to] of writes) {
        if (!out.includes(from)) throw new Error(`mineflayer physics.js: write site not found: ${from}`)
        out = out.replace(from, to)
      }
      return out.replace(
        featureAnchor,
        `${featureAnchor}
  // 26.3+: one acknowledgement per tick; the server rejects a second position
  // packet that arrives before client_tick_end.
  const sendsTickEnd = bot.supportFeature('sendsTickEnd')
  function writeMovement (name, params) {
    bot._client.write(name, params)
    if (sendsTickEnd) bot._client.write('tick_end', {})
  }`
      )
    }
  },
  {
    name: 'mineflayer declares native tick_end',
    file: () => path.join(pkgDir('mineflayer'), 'lib', 'version.js'),
    check: async (src) => src.includes('sendsClientTickEnd'),
    transform: (src) =>
      src.replace(
        /  oldestSupportedVersion: testedVersions\[0\]/,
        '  oldestSupportedVersion: testedVersions[0],\n  // patched: the physics loop acknowledges every tick, so host code must not\n  // send tick_end a second time\n  sendsClientTickEnd: true'
      )
  },
  {
    // 26.3 requires the confirm packet to echo the resulting position/rotation;
    // sending only the id makes the server drop the connection with
    // "Invalid move player packet received" (the missing fields serialise as
    // NaN coordinates). Upstream PR: PrismarineJS/mineflayer#4125.
    name: 'mineflayer teleport_confirm echoes position',
    file: () => path.join(pkgDir('mineflayer'), 'lib', 'plugins', 'physics.js'),
    check: async (src) => src.includes('teleportConfirmEchoesPosition'),
    transform(src) {
      const anchor = "    if (bot.supportFeature('teleportUsesOwnPacket')) {\n      bot._client.write('teleport_confirm', { teleportId: packet.teleportId })\n    }"
      if (!src.includes(anchor)) throw new Error('mineflayer physics.js: teleport_confirm write site not found')
      return src.replace(
        anchor,
        `    if (bot.supportFeature('teleportUsesOwnPacket')) {
      const confirmation = { teleportId: packet.teleportId }
      if (bot.supportFeature('teleportConfirmEchoesPosition')) {
        // 26.3+: the client reports the position/rotation resulting from the teleport
        confirmation.x = pos.x
        confirmation.y = pos.y
        confirmation.z = pos.z
        confirmation.yaw = newYaw
        confirmation.pitch = newPitch
      }
      bot._client.write('teleport_confirm', confirmation)
    }`
      )
    }
  },
  {
    name: 'minecraft-data features.json (teleportConfirmEchoesPosition)',
    async check() {
      const list = JSON.parse((await readOrNull(path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json'))) ?? '[]')
      return list.some((f) => f.name === 'teleportConfirmEchoesPosition')
    },
    async apply() {
      const file = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json')
      const list = JSON.parse(await readFile(file, 'utf8'))
      list.push({
        name: 'teleportConfirmEchoesPosition',
        description: 'confirm teleportation echoes the resulting position and rotation',
        versions: [VERSION, 'latest']
      })
      await writeFile(file, JSON.stringify(list, null, 2) + '\n')
      return true
    }
  },
  {
    // 26.3 replaced the flat i16 deltas of rel_entity_move / entity_move_look
    // with a packed form (net.minecraft.network.protocol.game.ClientboundMoveEntityPacket
    // + VecDelta): a varint properties field carries onGround in bit 0 and the
    // step count in the remaining bits, followed by either one i16 triplet or
    // that many (varint tickOffset, i16 dX, i16 dY, i16 dZ) steps. The entity id
    // stays on the packet itself, not in the delta.
    // protodef cannot express "count = properties >>> 1", so this is a native
    // type (upstream: PrismarineJS/node-minecraft-protocol#1538).
    name: 'minecraft-protocol entityDelta datatype',
    files: () => [
      path.join(pkgDir('minecraft-protocol'), 'src', 'datatypes', 'minecraft.js'),
      path.join(pkgDir('minecraft-protocol'), 'src', 'datatypes', 'compiler-minecraft.js'),
      path.join(pkgDir('minecraft-protocol'), 'src', 'datatypes', 'entity-delta.js')
    ],
    async check() {
      const [registryFile, compilerFile, moduleFile] = this.files()
      const registry = await readOrNull(registryFile)
      const compiler = await readOrNull(compilerFile)
      const impl = await readOrNull(moduleFile)
      return Boolean(
        registry?.includes("entityDelta: require('./entity-delta')") &&
        compiler?.includes("entityDelta: ['native', require('./entity-delta')[0]]") &&
        impl?.includes('function readEntityDelta')
      )
    },
    async apply() {
      const [registryFile, compilerFile, moduleFile] = this.files()

      // 1. standalone datatype: rewritten every run, so it can never go stale
      await writeFile(moduleFile, ENTITY_DELTA_SOURCE)

      // 2. register in the interpreter's type table
      let registry = await readFile(registryFile, 'utf8')
      // normalise any earlier generation of the registration line
      registry = registry.replace(/entityDelta: \[readEntityDelta[^\]]*\]/g, "entityDelta: require('./entity-delta')")
      if (!registry.includes("entityDelta: require('./entity-delta')")) {
        registry = registry.replace(
          '  lpVec3: [readLpVec3, writeLpVec3, sizeOfLpVec3]\n}',
          "  lpVec3: [readLpVec3, writeLpVec3, sizeOfLpVec3],\n  entityDelta: require('./entity-delta')\n}"
        )
      }
      // drop any earlier generation of the appended helpers
      const staleTail = registry.indexOf('\n/**\n * 26.3 packed entity movement.')
      if (staleTail >= 0) registry = registry.slice(0, staleTail) + '\n'
      if (registry.includes('readEntityDelta') && !registry.includes("entity-delta")) {
        registry = registry.replace(/\nfunction readEntityDelta[\s\S]*$/, '\n')
      }
      await writeFile(registryFile, registry)

      // 3. register in the compiled type table (Read / Write / SizeOf)
      let compiler = await readFile(compilerFile, 'utf8')
      for (const index of [0, 1, 2]) {
        if (compiler.includes(`require('./entity-delta')[${index}]`)) continue
        const anchor = `    varlong: ['native', minecraft.varlong[${index}]],`
        if (!compiler.includes(anchor)) throw new Error(`compiler-minecraft.js: varlong[${index}] anchor not found`)
        compiler = compiler.replace(anchor, `${anchor}\n    entityDelta: ['native', require('./entity-delta')[${index}]],`)
      }
      await writeFile(compilerFile, compiler)
      return true
    }
  },
  {
    // 26.3's entity_position_sync carries a *path*: either one absolute
    // position (linear) or a list of {x,y,z,tickOffset} steps. mineflayer reads
    // packet.x/y/z directly, so a stepped path sets NaN and the entity is lost;
    // the packet also no longer carries a velocity.
    name: 'mineflayer handles stepped entity position sync',
    file: () => path.join(pkgDir('mineflayer'), 'lib', 'plugins', 'entities.js'),
    check: async (src) => src.includes('entityPositionSyncHasSteps'),
    transform(src) {
      const from = `  bot._client.on('sync_entity_position', (packet) => {
    const entity = fetchEntity(packet.entityId)
    entity.position.set(packet.x, packet.y, packet.z)
    entity.velocity.set(packet.dx, packet.dy, packet.dz)
    entity.yaw = conv.fromNotchianYaw(packet.yaw)
    entity.pitch = conv.fromNotchianPitch(packet.pitch)
    bot.emit('entityMoved', entity)
  })`
      if (!src.includes(from)) throw new Error("mineflayer entities.js: sync_entity_position handler not found")
      const to = `  bot._client.on('sync_entity_position', (packet) => {
    const entity = fetchEntity(packet.entityId)
    if (bot.supportFeature('entityPositionSyncHasSteps')) {
      // 26.3: absolute end position, or a step list whose last entry is it
      const steps = Array.isArray(packet.steps) ? packet.steps : []
      const end = steps.length > 0 ? steps[steps.length - 1] : packet
      if (typeof end.x === 'number' && Number.isFinite(end.x)) entity.position.set(end.x, end.y, end.z)
    } else {
      entity.position.set(packet.x, packet.y, packet.z)
      entity.velocity.set(packet.dx, packet.dy, packet.dz)
    }
    entity.yaw = conv.fromNotchianYaw(packet.yaw)
    entity.pitch = conv.fromNotchianPitch(packet.pitch)
    bot.emit('entityMoved', entity)
  })`
      return src.replace(from, to)
    }
  },
  {
    name: 'minecraft-data features.json (entityPositionSyncHasSteps)',
    async check() {
      const list = JSON.parse((await readOrNull(path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json'))) ?? '[]')
      return list.some((f) => f.name === 'entityPositionSyncHasSteps')
    },
    async apply() {
      const file = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json')
      const list = JSON.parse(await readFile(file, 'utf8'))
      list.push({
        name: 'entityPositionSyncHasSteps',
        description: 'entity_position_sync carries a linear or stepped absolute position path',
        versions: [VERSION, 'latest']
      })
      await writeFile(file, JSON.stringify(list, null, 2) + '\n')
      return true
    }
  },  {
    name: 'mineflayer consumes entityDelta',
    file: () => path.join(pkgDir('mineflayer'), 'lib', 'plugins', 'entities.js'),
    check: async (src) => src.includes('entityMoveUsesDelta'),
    transform(src) {
      const from = `    if (bot.supportFeature('fixedPointDelta')) {
      entity.position.translate(packet.dX / 32, packet.dY / 32, packet.dZ / 32)
    } else if (bot.supportFeature('fixedPointDelta128')) {
      entity.position.translate(packet.dX / (128 * 32), packet.dY / (128 * 32), packet.dZ / (128 * 32))
    }`
      if (!src.includes(from)) throw new Error('mineflayer entities.js: relative-move blocks not found')
      const to = `    if (bot.supportFeature('entityMoveUsesDelta')) {
      // 26.3: packed delta, 12 fractional bits, steps already summed
      entity.position.translate(packet.move.dX / 4096, packet.move.dY / 4096, packet.move.dZ / 4096)
    } else if (bot.supportFeature('fixedPointDelta')) {
      entity.position.translate(packet.dX / 32, packet.dY / 32, packet.dZ / 32)
    } else if (bot.supportFeature('fixedPointDelta128')) {
      entity.position.translate(packet.dX / (128 * 32), packet.dY / (128 * 32), packet.dZ / (128 * 32))
    }`
      return src.split(from).join(to)
    }
  },
  {
    name: 'minecraft-data features.json (entityMoveUsesDelta)',
    async check() {
      const list = JSON.parse((await readOrNull(path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json'))) ?? '[]')
      return list.some((f) => f.name === 'entityMoveUsesDelta')
    },
    async apply() {
      const file = path.join(pkgDir('minecraft-data'), 'minecraft-data', 'data', 'pc', 'common', 'features.json')
      const list = JSON.parse(await readFile(file, 'utf8'))
      list.push({
        name: 'entityMoveUsesDelta',
        description: 'relative entity movement uses the packed entityDelta form (onGround + step list)',
        versions: [VERSION, 'latest']
      })
      await writeFile(file, JSON.stringify(list, null, 2) + '\n')
      return true
    }
  },
  {
    // prismarine-physics keys physics features on the exact majorVersion string,
    // so 26.3 silently loses every feature 26.1 had (the visible symptom is
    // "No liquid gravity settings"). 26.3 has no physics change over 26.1, so
    // it inherits the 26.1 feature set wholesale.
    name: 'prismarine-physics 26.3 features',
    async check() {
      const file = path.join(pkgDir('prismarine-physics'), 'lib', 'features.json')
      const list = JSON.parse((await readOrNull(file)) ?? '[]')
      const inherited = list.filter((f) => f.versions.includes('26.1'))
      return inherited.length > 0 && inherited.every((f) => f.versions.includes(VERSION))
    },
    async apply() {
      const file = path.join(pkgDir('prismarine-physics'), 'lib', 'features.json')
      const list = JSON.parse(await readFile(file, 'utf8'))
      for (const feature of list) {
        if (feature.versions.includes('26.1') && !feature.versions.includes(VERSION)) feature.versions.push(VERSION)
      }
      await writeFile(file, JSON.stringify(list, null, 2) + '\n')
      return true
    }
  }
]

/**
 * Apply (or verify) every patch.
 * @param {{ check?: boolean, quiet?: boolean }} [options]
 * @returns {Promise<boolean>} true when all patches are in place afterwards
 */
export async function applyAll({ check = false, quiet = false } = {}) {
  const results = []
  for (const patch of patches) {
    if (patch.file) {
      const file = patch.file()
      const src = await readOrNull(file)
      if (src === null) {
        results.push({ name: patch.name, state: 'SKIP (package missing)' })
        continue
      }
      if (await patch.check(src)) {
        results.push({ name: patch.name, state: 'ok' })
        continue
      }
      if (check) {
        results.push({ name: patch.name, state: 'MISSING' })
        continue
      }
      await writeFile(file, patch.transform(src))
      results.push({ name: patch.name, state: 'patched' })
      continue
    }
    if (await patch.check()) {
      results.push({ name: patch.name, state: 'ok' })
      continue
    }
    if (check) {
      results.push({ name: patch.name, state: 'MISSING' })
      continue
    }
    await patch.apply()
    results.push({ name: patch.name, state: 'patched' })
  }

  if (!quiet) {
    const width = Math.max(...results.map((r) => r.name.length))
    for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.state}`)
  }
  const incomplete = results.filter((r) => r.state === 'MISSING' || r.state.startsWith('SKIP'))
  if (!quiet && !check && incomplete.length === 0) {
    console.log(`\nMinecraft ${VERSION} (protocol ${PROTOCOL}) support installed.`)
  }
  return incomplete.length === 0
}

/** Verify-only helper for tests and CI. */
export const runCompatCheck = () => applyAll({ check: true, quiet: true })

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const ok = await applyAll({ check })
  if (!ok) {
    console.error(`\n${check ? 'Patch check failed' : 'Installation incomplete'}: run node scripts/install-263-compat.mjs`)
    process.exitCode = 1
  }
  void DATA_VERSION
}



