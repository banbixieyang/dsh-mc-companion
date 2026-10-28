#!/usr/bin/env node
/**
 * Minimal native 26.3 connection probe.
 *
 * Talks to a running server with plain mineflayer (no plugin layer) and prints
 * every lifecycle event plus a few protocol touchstones: chunk data arriving,
 * a real block under the player, position sync, chat. Use it to separate
 * protocol-stack problems from companion-plugin problems.
 *
 * Usage: node tools/probe-263.mjs [host] [port] [version]
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.join(HERE, '..', 'package.json'))
const mineflayer = require('mineflayer')

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 25566)
const version = process.argv[4] ?? '26.3'
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (...args) => console.log(stamp(), ...args)

const bot = mineflayer.createBot({ host, port, username: `Probe${Math.floor(Math.random() * 1000)}`, version, auth: 'offline' })

const debug = process.env.MC_PROBE_DEBUG === '1'
const packets = new Map()
bot.on('packet', (data, meta) => {
  packets.set(meta.name, (packets.get(meta.name) ?? 0) + 1)
  if (debug && ['position', 'login', 'spawn_entity'].includes(meta.name)) log('recv', meta.name, JSON.stringify(data).slice(0, 400))
})
if (debug || process.env.MC_PROBE_DROP) {
  // Bisect which outbound packet the 26.3 server rejects: MC_PROBE_DROP=a,b,c
  const drop = new Set((process.env.MC_PROBE_DROP ?? '').split(',').filter(Boolean))
  const originalWrite = bot._client.write.bind(bot._client)
  let writes = 0
  bot._client.write = (name, params) => {
    if (drop.has(name)) {
      log('DROP', name)
      return
    }
    if (process.env.MC_PROBE_ONGROUND === '1' && ['position', 'position_look', 'look', 'flying'].includes(name)) {
      params = { ...params, onGround: true, flags: { onGround: true } }
    }
    if (debug && writes++ < 40) {
      let hex = ''
      try {
        const ser = require('minecraft-protocol/src/transforms/serializer')
        const s = ser.createSerializer({ state: 'play', isServer: false, version })
        hex = s.createPacketBuffer({ name, params }).toString('hex')
      } catch (error) {
        hex = `(serialize failed: ${error.message})`
      }
      log('send', name, JSON.stringify(params)?.slice(0, 200), '->', hex)
    }
    return originalWrite(name, params)
  }
}

bot.on('login', () => log('login  version=', bot.version))
bot.on('spawn', () => {
  log('spawn  pos=', bot.entity.position.toString())
  setTimeout(() => {
    const p = bot.entity.position.floored()
    const below = bot.blockAt(p.offset(0, -1, 0))
    log('block below =', below?.name, JSON.stringify({ x: p.x, y: p.y, z: p.z }))
    log('chunks loaded columns =', Object.keys(bot.world.columns ?? {}).length)
    log('packets seen:', [...packets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}x${v}`).join(' '))
    bot.chat('probe: native 26.3 ok?')
    setTimeout(() => {
      log('still connected after tick_end window:', bot.entity != null)
      bot.quit()
      process.exit(0)
    }, 4000)
  }, 3000)
})
bot.on('chat', (username, message) => log(`chat <${username}> ${message}`))
bot.on('kicked', (reason) => { log('KICKED', JSON.stringify(reason)); process.exit(2) })
bot.on('error', (error) => log('ERROR', error.message))
bot.on('end', (reason) => { log('END', reason); process.exit(3) })

setTimeout(() => { log('TIMEOUT waiting for spawn'); process.exit(4) }, 60_000)
