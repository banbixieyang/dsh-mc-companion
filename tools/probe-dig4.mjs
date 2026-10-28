#!/usr/bin/env node
/**
 * Dig probe 4: dig a block we are *actually standing next to*, and prove the
 * break by a server side signal (inventory/drop), not by the client's own view.
 */
import { createRequire } from 'node:module'

import { installDigSequence } from '../lib/digfix.js'

const require = createRequire(import.meta.url)
const mineflayer = require('mineflayer')
const pathfinder = require('mineflayer-pathfinder')

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 20000)
const username = process.argv[4] ?? 'DigProbe5'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (...args) => console.log('[dig4]', ...args)

const bot = mineflayer.createBot({ host, port, username, auth: 'offline', version: '26.3', hideErrors: true })
const changes = []

bot.once('spawn', async () => {
  log(`spawned mode=${bot.game.gameMode} pos=${bot.entity.position.x.toFixed(0)},${bot.entity.position.z.toFixed(0)}`)
  bot._client.on('block_change', (packet) => {
    changes.push({ at: Date.now(), position: packet?.location ?? packet?.position })
  })
  installDigSequence(bot, { log: (message) => log(message) })
  bot.loadPlugin(pathfinder.pathfinder)

  const ids = Object.keys(bot.registry.blocksByName).filter((n) => /_log$|_wood$/.test(n)).map((n) => bot.registry.blocksByName[n].id)
  let found = bot.findBlocks({ matching: (b) => ids.includes(b?.type), maxDistance: 128, count: 5 })
  for (let attempt = 0; attempt < 6 && found.length === 0; attempt++) {
    const d = [[24, 0], [-24, 0], [0, 24], [0, -24], [48, 48], [-48, -48]][attempt]
    const target = { x: Math.round(bot.entity.position.x + d[0]), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z + d[1]) }
    await bot.pathfinder.goto(new pathfinder.goals.GoalNear(target.x, target.y, target.z, 2)).catch(() => null)
    await sleep(400)
    found = bot.findBlocks({ matching: (b) => ids.includes(b?.type), maxDistance: 64, count: 5 })
  }
  if (found.length === 0) { log('no logs'); bot.quit(); return }

  // Walk right up to it and re-read the block from the server-synced position.
  const goal = found[0]
  await bot.pathfinder.goto(new pathfinder.goals.GoalNear(goal.x, goal.y, goal.z, 2)).catch(() => null)
  await sleep(500)
  const block = bot.blockAt(goal)
  const distance = bot.entity.position.distanceTo(block.position)
  log(`target ${block.name} at ${block.position.x},${block.position.y},${block.position.z} distance=${distance.toFixed(2)}`)

  const logsBefore = bot.inventory.items().filter((i) => /_log$/.test(i.name)).reduce((s, i) => s + i.count, 0)
  const changesBefore = changes.length
  const startedAt = Date.now()

  try {
    await bot.dig(block, true)
  } catch (error) {
    log(`dig threw: ${error.message}`)
  }
  await sleep(2_500)

  const logsAfter = bot.inventory.items().filter((i) => /_log$/.test(i.name)).reduce((s, i) => s + i.count, 0)
  const drops = Object.values(bot.entities).filter((e) => e?.name === 'item' && e.position?.distanceTo?.(block.position) <= 4).length
  const confirmed = changes.slice(changesBefore).filter((entry) => {
    const p = entry.position
    return p && Math.floor(p.x) === block.position.x && Math.floor(p.y) === block.position.y && Math.floor(p.z) === block.position.z
  }).length
  log(`logs ${logsBefore} -> ${logsAfter} | drops near: ${drops} | block_change at target: ${confirmed} | packets total: ${changes.length - changesBefore}`)
  if (changes.length > changesBefore) {
    const sample = changes.slice(changesBefore, changesBefore + 3).map((entry) => entry.position && `${Math.floor(entry.position.x)},${Math.floor(entry.position.y)},${Math.floor(entry.position.z)}`)
    log(`sample block_change: ${sample.join(' | ')}`)
  }
  log(logsAfter > logsBefore || drops > 0 || confirmed > 0 ? 'RESULT: server broke the block' : 'RESULT: still ignored')
  await sleep(300)
  bot.quit()
  process.exit(0)
})

bot.on('error', (error) => log(`error: ${error.message}`))
bot.on('kicked', (reason) => log(`kicked: ${JSON.stringify(reason).slice(0, 160)}`))
setTimeout(() => { log('timeout'); process.exit(1) }, 240_000)

