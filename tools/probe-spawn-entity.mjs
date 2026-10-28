#!/usr/bin/env node
/**
 * Why do entities end up with NaN positions on 26.3?
 *
 * Connects a single observer and prints, for every spawn_entity packet, the raw
 * fields, the entity mineflayer built from it, and the type lookup that
 * decided player-vs-non-player. Run against a server with mobs or a second bot.
 *
 * Usage: node tools/probe-spawn-entity.mjs [host] [port] [version]
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stamp = () => new Date().toISOString().slice(11, 23)
const log = (...args) => console.log(stamp(), ...args)

const bot = mineflayer.createBot({ host, port, username: `Spawn${Date.now() % 1000}`, version, auth: 'offline' })

bot.on('entitySpawn', (entity) => {
  log(`entitySpawn #${entity.id} name=${entity.name} type=${entity.type} pos=${entity.position.toString()}`)
})

await new Promise((resolve, reject) => {
  bot.once('spawn', resolve)
  bot.once('error', reject)
})
log('bot spawned, waiting for entity spawns...')
await sleep(6000)

const sample = Object.values(bot.entities).slice(0, 5)
for (const entity of sample) {
  log(`entity #${entity.id} ${entity.name ?? entity.username} pos=${entity.position.toString()}`)
}
if (sample.length === 0) log('no entities tracked')
bot.quit()
process.exit(0)
