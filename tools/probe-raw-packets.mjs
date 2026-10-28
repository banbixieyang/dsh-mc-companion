#!/usr/bin/env node
/**
 * Raw protocol probe: what does the server actually send on join + summon?
 *
 * Uses minecraft-protocol directly (no mineflayer), so mineflayer handlers and
 * our plugin code cannot hide a packet. Prints every clientbound packet id and
 * name for a few seconds around a summoned mob.
 *
 * Usage: node tools/probe-raw-packets.mjs [version] [port] [rconPort]
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RCON_PASSWORD, rconCommand } from '../scripts/rcon.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(HERE, '..', 'package.json'))
const protocol = require('minecraft-protocol')

const version = process.argv[2] ?? '1.20.4'
const port = Number(process.argv[3] ?? 25565)
const rconPort = Number(process.argv[4] ?? 25575)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (...args) => console.log(stamp(), ...args)

const client = protocol.createClient({ host: '127.0.0.1', port, username: 'RawProbe', version, auth: 'offline' })
const seen = new Map()
client.on('packet', (data, meta) => {
  seen.set(meta.name, (seen.get(meta.name) ?? 0) + 1)
  if (/spawn|entity/.test(meta.name)) log('  <-', meta.name, JSON.stringify(data).slice(0, 120))
})
client.on('error', (error) => log('error:', error.message))
client.on('end', (reason) => log('end:', reason))

await new Promise((resolve, reject) => {
  client.once('login', resolve)
  client.once('error', reject)
})
log('logged in')

// wait for the play state (position packet) before summoning
await sleep(3000)
const position = client.entity?.position ?? { x: 0, y: 0, z: 0 }
log('client position:', JSON.stringify(position))
const x = Math.floor(position.x) + 2
const y = Math.floor(position.y)
const z = Math.floor(position.z)
log('summon ->', JSON.stringify(await rconCommand({ port: rconPort, password: RCON_PASSWORD, command: `summon pig ${x} ${y} ${z}` })))
await sleep(2500)
log('exists?', JSON.stringify(await rconCommand({ port: rconPort, password: RCON_PASSWORD, command: 'execute if entity @e[type=pig,limit=1] run say yes-pig' })))
log('packets:', [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([name, count]) => `${name}x${count}`).join(' '))
client.end()
process.exit(0)
