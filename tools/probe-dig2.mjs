#!/usr/bin/env node
/**
 * Dig probe v2: verify the 26.3 dig sequence end-to-end.
 *
 * Order matters: the probe hook is installed *before* the dig-sequence fix, so
 * the hook sees the payload the fix produced.
 */
import { createRequire } from 'node:module'

import { installDigSequence } from '../lib/digfix.js'

const require = createRequire(import.meta.url)
const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder')

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 20000)
const username = process.argv[4] ?? 'DigProbe'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.log('[dig-probe]', ...args)

const bot = mineflayer.createBot({ host, port, username, auth: 'offline', version: '26.3', hideErrors: true })
let lastAck = null
const digWrites = []

bot.once('spawn', async () => {
  log(`spawned version=${bot.version} gameMode=${bot.game.gameMode}`)

  const client = bot._client
  const hookWrite = client.write.bind(client)
  client.write = (name, params) => {
    if (name === 'block_dig') digWrites.push(JSON.parse(JSON.stringify(params ?? {})))
    return hookWrite(name, params)
  }
  client.on('acknowledge_player_digging', (packet) => {
    lastAck = packet
  })

  installDigSequence(bot, { log: (message) => log(message) })
  bot.on('diggingCompleted', (block) => log(`event diggingCompleted ${block?.name}`))
  bot.on('diggingAborted', (block) => log(`event diggingAborted ${block?.name}`))

  bot.loadPlugin(pathfinder.pathfinder)
  const blockIds = bot.registry.blocksByName
  const logIds = Object.keys(blockIds).filter((name) => /_log$|_wood$/.test(name)).map((name) => blockIds[name].id)
  let found = bot.findBlocks({ matching: (block) => logIds.includes(block?.type), maxDistance: 96, count: 5 })
  for (let attempt = 0; attempt < 4 && found.length === 0; attempt++) {
    const dx = [16, -16, 0, 0][attempt]
    const dz = [0, 0, 16, -16][attempt]
    const target = { x: Math.round(bot.entity.position.x + dx), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z + dz) }
    log(`walking to ${target.x},${target.z}`)
    await bot.pathfinder.goto(new pathfinder.goals.GoalNear(target.x, target.y, target.z, 2)).catch(() => null)
    await sleep(400)
    found = bot.findBlocks({ matching: (block) => logIds.includes(block?.type), maxDistance: 64, count: 5 })
  }
  if (found.length === 0) {
    log('no logs found; aborting')
    bot.quit()
    return
  }

  const position = found[0]
  const block = bot.blockAt(position)
  log(`target ${block.name} at ${position.x},${position.y},${position.z} dist=${bot.entity.position.distanceTo(position).toFixed(1)} digTime=${bot.digTime(block)}`)
  log(`ack seen before dig: ${JSON.stringify(lastAck)}`)

  const before = bot.inventory.items().filter((item) => /_log$/.test(item.name)).reduce((sum, item) => sum + item.count, 0)
  try {
    await bot.dig(block, true)
  } catch (error) {
    log(`dig threw: ${error.message}`)
  }
  await sleep(2_500)
  const after = bot.blockAt(position)
  const logs = bot.inventory.items().filter((item) => /_log$/.test(item.name)).reduce((sum, item) => sum + item.count, 0)
  log(`block after: ${after?.name} | logs ${before} -> ${logs}`)
  log(`dig payloads: ${JSON.stringify(digWrites.slice(0, 6))}`)
  log(after?.name === 'air' ? 'RESULT: dig works' : 'RESULT: dig ignored')
  await sleep(300)
  bot.quit()
  process.exit(0)
})

bot.on('error', (error) => log(`error: ${error.message}`))
bot.on('kicked', (reason) => log(`kicked: ${JSON.stringify(reason).slice(0, 160)}`))
setTimeout(() => {
  log('timeout')
  process.exit(1)
}, 150_000)
