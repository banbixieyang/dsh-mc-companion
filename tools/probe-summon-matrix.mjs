#!/usr/bin/env node
/**
 * Why does a summoned mob vanish on the local test server?
 *
 * Summons one living entity, one item and one armour stand, then asks the server
 * whether each still exists. Living entities disappearing while armour stands
 * survive points at a world/gamerule setting rather than at the protocol.
 *
 * Usage: node tools/probe-summon-matrix.mjs [rconPort]
 */
import { RCON_PASSWORD, rconCommand } from '../scripts/rcon.mjs'

const port = Number(process.argv[2] ?? 25575)
const rcon = (command) => rconCommand({ port, password: RCON_PASSWORD, command })

const cases = [
  ['pig', 'summon pig 2 -60 2', 'data get entity @e[type=pig,limit=1] Pos'],
  ['zombie', 'summon zombie 3 -60 3', 'data get entity @e[type=zombie,limit=1] Pos'],
  ['armor_stand', 'summon armor_stand 4 -60 4', 'data get entity @e[type=armor_stand,limit=1] Pos'],
  ['item', 'summon item 5 -60 5 {Item:{id:"minecraft:stone",Count:1b}}', 'data get entity @e[type=item,limit=1] Pos']
]

for (const [label, summon, query] of cases) {
  const summoned = await rcon(summon).catch((error) => `ERR ${error.message}`)
  const found = await rcon(query).catch((error) => `ERR ${error.message}`)
  console.log(`${label.padEnd(12)} summon=${JSON.stringify(summoned)} exists=${JSON.stringify(found)}`)
}

for (const rule of ['gamerule doMobSpawning', 'gamerule doMobLoot', 'difficulty', 'gamerule mobGriefing']) {
  console.log(rule, '=>', JSON.stringify(await rcon(rule).catch((error) => `ERR ${error.message}`)))
}
