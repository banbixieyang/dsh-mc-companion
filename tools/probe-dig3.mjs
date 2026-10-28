#!/usr/bin/env node
/**
 * Probe the plugin's own digBlock path against a 26.3 server, including the new
 * server-confirmation check.
 */
import { createRequire } from 'node:module'

import { installDigSequence } from '../lib/digfix.js'
import { digBlock } from '../lib/behaviors/helpers.js'

const require = createRequire(import.meta.url)
const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder')

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 20000)
const username = process.argv[4] ?? 'DigProbe3'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.log('[dig3]', ...args)

const bot = mineflayer.createBot({ host, port, username, auth: 'offline', version: '26.3', hideErrors: true })
let blockChangePackets = 0

bot.once('spawn', async () => {
  log(`spawned version=${bot.version} mode=${bot.game.gameMode}`)
  bot._client.on('block_change', (packet) => {
    blockChangePackets += 1
    log('block_change at ' + JSON.stringify(packet?.location ?? packet) + ' state=' + (packet?.newBlockState ?? packet?.type ?? '?'))
  })
  bot._client.on('acknowledge_player_digging', (packet) => log('ack ' + JSON.stringify(packet)))
  const origWrite = bot._client.write.bind(bot._client)
  bot._client.write = (name, params) => {
    if (name === 'block_dig') log('dig write ' + JSON.stringify(params))
    return origWrite(name, params)
  }
  installDigSequence(bot, { log: (message) => log(message) })
  bot.loadPlugin(pathfinder.pathfinder)

  const blockIds = bot.registry.blocksByName
  const logIds = Object.keys(blockIds).filter((name) => /_log$|_wood$/.test(name)).map((name) => blockIds[name].id)
  let found = bot.findBlocks({ matching: (block) => logIds.includes(block?.type), maxDistance: 128, count: 5 })
  for (let attempt = 0; attempt < 5 && found.length === 0; attempt++) {
    const dx = [24, -24, 0, 0, 24][attempt]
    const dz = [0, 0, 24, -24, 24][attempt]
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

  const block = bot.blockAt(found[0])
  log(`target ${block.name} at ${found[0].x},${found[0].y},${found[0].z} dist=${bot.entity.position.distanceTo(block.position).toFixed(1)}`)
  const before = blockChangePackets
  const result = await digBlock(bot, { goals: pathfinder.goals }, block, { digTimeoutMs: 20_000, pathTimeoutMs: 20_000 })
  log(`digBlock result: ${JSON.stringify(result)}`)
  log(`block_change packets: ${before} -> ${blockChangePackets}`)
  const logs = bot.inventory.items().filter((item) => /_log$/.test(item.name)).reduce((sum, item) => sum + item.count, 0)
  log(`log inventory: ${logs}`)
  await sleep(500)
  bot.quit()
  process.exit(result.ok ? 0 : 1)
})

bot.on('error', (error) => log(`error: ${error.message}`))
bot.on('kicked', (reason) => log(`kicked: ${JSON.stringify(reason).slice(0, 160)}`))
setTimeout(() => { log('timeout'); process.exit(1) }, 150_000)

