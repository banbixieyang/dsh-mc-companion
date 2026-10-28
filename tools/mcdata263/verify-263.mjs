#!/usr/bin/env node
/**
 * Strict verification of the installed 26.3 protocol.json against Mojang's own
 * packet report.
 *
 * Usage: node verify-263.mjs [<mcdata-26.3-dir>] [<reports-26.3>] [<reports-26.1>]
 *
 * protodef keeps historical packet names (`position`, `block_place`, ...) while
 * Mojang renames things, so names cannot be compared directly. The bridge is
 * 26.1: there both the published protodef data and the official report exist,
 * so name pairs are learned from 26.1 ids and then used to check every 26.3 id.
 *
 * Exit code 1 means the installed data disagrees with the server's own report.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const VERSION = '26.3'

const mcdataDir = path.resolve(
  process.argv[2] ?? path.join(HERE, '..', '..', 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', VERSION)
)
const rep263Dir = path.resolve(process.argv[3] ?? path.join(HERE, 'reports', '26.3'))
const rep261Dir = path.resolve(process.argv[4] ?? path.join(HERE, 'reports', '26.1'))
const published261Dir = path.resolve(
  process.argv[5] ?? path.join(HERE, '..', '..', 'node_modules', 'minecraft-data', 'minecraft-data', 'data', 'pc', '26.1')
)

const STATES = { handshaking: 'handshaking', status: 'status', login: 'login', configuration: 'configuration', play: 'play' }
const DIRS = { toClient: 'clientbound', toServer: 'serverbound' }
// The legacy ping and the handshake's own id are not part of the official
// packet report (legacy ping is not a framed packet at all).
const IGNORED = new Set(['handshaking/toServer/set_protocol', 'handshaking/toServer/legacy_server_list_ping'])

const idOf = (packetType) => {
  const nameField = packetType[1].find((field) => field.name === 'name')
  const raw = nameField?.type?.[1]?.mappings ?? {}
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [value, key.startsWith('0x') ? parseInt(key, 16) : Number(key)]))
}

const reportTable = (report, state, dir) =>
  Object.fromEntries(
    Object.entries(report[state]?.[dir] ?? {})
      .filter(([name]) => name !== 'protocol_id')
      .map(([name, def]) => [name.replace('minecraft:', ''), def.protocol_id])
  )

const loadProtocol = async (dir) => JSON.parse(await readFile(path.join(dir, 'protocol.json'), 'utf8'))

const proto261 = await loadProtocol(published261Dir)
const proto263 = await loadProtocol(mcdataDir)
const rep261 = JSON.parse(await readFile(path.join(rep261Dir, 'packets.json'), 'utf8'))
const rep263 = JSON.parse(await readFile(path.join(rep263Dir, 'packets.json'), 'utf8'))

const problems = []
const learned = new Map()
let checked = 0

for (const [protoState, reportState] of Object.entries(STATES)) {
  for (const [protoDir, reportDir] of Object.entries(DIRS)) {
    const t261 = proto261[protoState]?.[protoDir]?.types?.packet
    const t263 = proto263[protoState]?.[protoDir]?.types?.packet
    if (!t261 || !t263) continue
    const ids261 = idOf(t261)
    const ids263 = idOf(t263)
    const official261 = reportTable(rep261, reportState, reportDir)
    const official263 = reportTable(rep263, reportState, reportDir)

    // Learn protodef name -> Mojang name from 26.1, where both tables exist.
    for (const [name, id] of Object.entries(ids261)) {
      const official = Object.entries(official261).find(([, officialId]) => officialId === id)?.[0]
      if (official) learned.set(`${protoState}/${protoDir}/${name}`, official)
    }

    for (const [name, id] of Object.entries(ids263)) {
      if (IGNORED.has(`${protoState}/${protoDir}/${name}`)) continue
      const official263Name = Object.entries(official263).find(([, officialId]) => officialId === id)?.[0]
      if (!official263Name) {
        problems.push(`${protoState}/${protoDir}: ${name} id ${id} is not a valid 26.3 packet id`)
        continue
      }
      const learnedName = learned.get(`${protoState}/${protoDir}/${name}`)
      if (!learnedName) {
        problems.push(`NEW ${protoState}/${protoDir}: ${name} -> id ${id} (official "${official263Name}")`)
        continue
      }
      checked++
      if (!(learnedName in official263)) {
        problems.push(`STALE ${protoState}/${protoDir}: ${name} was "${learnedName}" in 26.1, absent from 26.3, still defined at id ${id}`)
        continue
      }
      const expected = official263[learnedName]
      if (expected !== id) problems.push(`ID  ${protoState}/${protoDir}: ${name} (${learnedName}) expected ${expected}, got ${id}`)
    }

    for (const [officialName, officialId] of Object.entries(official263)) {
      if (!Object.values(ids263).includes(officialId)) problems.push(`MISSING ${protoState}/${protoDir}: official "${officialName}" id ${officialId} has no protodef entry`)
    }
  }
}

const newPackets = problems.filter((problem) => problem.startsWith('NEW '))
const real = problems.filter((problem) => !problem.startsWith('NEW '))
console.log(`checked ${checked} packets that have a 26.1 counterpart`)
console.log(`new packets: ${newPackets.length} (protocol 777 adds 6)`)
for (const problem of newPackets) console.log(`  ${problem}`)
console.log(`\nproblems: ${real.length}`)
for (const problem of real) console.log(`  ${problem}`)
if (real.length) process.exitCode = 1
