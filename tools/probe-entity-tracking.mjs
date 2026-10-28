#!/usr/bin/env node
/**
 * Two-bot entity-tracking probe for Minecraft 26.3.
 *
 * One bot stands still and watches; the other walks forward. Prints which
 * movement packets the observer receives and how the observed position evolves,
 * which isolates "is the packed entity delta parsed correctly" from the rest of
 * the companion plugin.
 *
 * Usage: node tools/probe-entity-tracking.mjs [host] [port]
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

const observer = mineflayer.createBot({ host, port, username: 'Observer', version, auth: 'offline' })

const counts = new Map()
observer._client.on('packet', (data, meta) => {
  counts.set(meta.name, (counts.get(meta.name) ?? 0) + 1)
  if (/spawn_entity|rel_entity_move|entity_move_look|entity_look/.test(meta.name)) {
    log('  <-', meta.name, JSON.stringify(data).slice(0, 200))
  }
})
observer._client.on('error', (error) => log('  client error:', error.message))

await new Promise((resolve, reject) => {
  observer.once('spawn', resolve)
  observer.once('error', reject)
})
log('observer spawned at', observer.entity.position.toString())

const walker = mineflayer.createBot({ host, port, username: 'Walker', version, auth: 'offline' })
await new Promise((resolve, reject) => {
  walker.once('spawn', resolve)
  walker.once('error', reject)
})
log('walker spawned at', walker.entity.position.toString())

await sleep(1_500)
const find = () => Object.values(observer.entities).find((entity) => entity.username === 'Walker')
const entity = find()
log('observer sees walker:', Boolean(entity), entity ? `id=${entity.id} pos=${entity.position.toString()}` : '')
log('players table:', Object.entries(observer.players).map(([name, p]) => `${name}:entity=${p.entity ? `#${p.entity.id}@${p.entity.position.toString()}` : 'none'}`).join(' | '))
log('entity ids:', Object.values(observer.entities).slice(0, 6).map((e) => `#${e.id}:${e.username ?? e.name}@${e.position.toString().slice(0, 24)}`).join(' , '))
if (!entity) {
  log('observer entity list:', Object.values(observer.entities).map((e) => `${e.username ?? e.name}#${e.id}`).join(', '))
}

const start = entity ? entity.position.clone() : null
walker.setControlState('forward', true)
for (let i = 0; i < 8; i++) {
  await sleep(500)
  const current = find()
  log(
    `t+${((i + 1) * 0.5).toFixed(1)}s walker(server-side)=${walker.entity.position.toString()}`,
    `observer sees=${current ? current.position.toString() : 'gone'}`,
    start && current ? `moved=${current.position.distanceTo(start).toFixed(2)}` : ''
  )
}
walker.setControlState('forward', false)

log('all packets seen by observer:',
  [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => `${name}x${count}`).join(' '))

walker.quit()
observer.quit()
process.exit(0)




