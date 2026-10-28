#!/usr/bin/env node
/**
 * Fetch the Minecraft 26.3 data set (protocol + block/item/entity tables) and
 * verify it against the packet id table extracted from Mojang's own 26.3 server.
 *
 * Usage: node sync-263.mjs <reports-dir>
 *
 * Source: PrismarineJS/minecraft-data's unreleased 26.3 work (MIT), branch
 * `pc-26.3-support` (PR #1301). Upstream has not published 26.3 to npm, so the
 * files are vendored into this repo. The packet-id check below is the guard
 * against trusting unverified third-party data: ids come from the official
 * `--reports` dump, never from the branch.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REPO = 'DallasCarraher/minecraft-data'
const BRANCH = 'pc-26.3-support'
const BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/data/pc/26.3/`
const VENDOR = path.resolve(HERE, '..', '..', 'vendor', 'mc-data-26.3')

export const FILES = [
  'version.json',
  'protocol.json',
  'blocks.json',
  'items.json',
  'entities.json',
  'blockCollisionShapes.json',
  'foods.json',
  'recipes.json'
]

const reportsDir = path.resolve(process.argv[2] ?? path.join(HERE, 'reports', '26.3'))
await mkdir(VENDOR, { recursive: true })

for (const f of FILES) {
  const res = await fetch(BASE + f)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${f}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(path.join(VENDOR, f), buf)
  console.log(`${f}: ${(buf.length / 1024).toFixed(0)} KB`)
}

// ---- verification -------------------------------------------------------
const report = JSON.parse(await readFile(path.join(reportsDir, 'packets.json'), 'utf8'))
const protocol = JSON.parse(await readFile(path.join(VENDOR, 'protocol.json'), 'utf8'))

const STATES = { handshaking: 'handshaking', status: 'status', login: 'login', configuration: 'configuration', play: 'play' }
const DIRS = { toClient: 'clientbound', toServer: 'serverbound' }

let checked = 0
const problems = []
for (const [protoState, reportState] of Object.entries(STATES)) {
  const state = protocol[protoState]
  if (!state) { problems.push(`protocol.json missing state ${protoState}`); continue }
  for (const [protoDir, reportDir] of Object.entries(DIRS)) {
    const pktType = state[protoDir]?.types?.packet
    if (!pktType) continue
    // container -> [{name:'name', type:['mapper', {type:'varint', mappings:{'0x00': pkt}}]}, ...]
    const nameField = pktType[1].find((f) => f.name === 'name')
    const rawMappings = nameField?.type?.[1]?.mappings ?? {}
    // ids are hex strings in the mapping table; normalise to numbers
    const mapper = Object.fromEntries(
      Object.entries(rawMappings).map(([k, v]) => [v, k.startsWith('0x') ? parseInt(k, 16) : Number(k)])
    )
    const reportTable = report[reportState]?.[reportDir] ?? {}
    const reportById = new Map()
    for (const [name, def] of Object.entries(reportTable)) {
      if (name === 'protocol_id') continue
      reportById.set(def.protocol_id, name.replace('minecraft:', ''))
    }
    for (const [name, id] of Object.entries(mapper)) {
      checked++
      const official = reportById.get(id)
      if (!official) { problems.push(`${protoState}/${protoDir}: ${name} -> id ${id} not in official table`); continue }
      // protodef names are historical; compare loosely on token overlap
      const a = name.replace(/_/g, '')
      const b = official.replace(/_/g, '')
      if (a !== b && !a.includes(b) && !b.includes(a)) {
        problems.push(`${protoState}/${protoDir}: ${name} (id ${id}) != official "${official}"`)
      }
    }
    const missingIds = [...reportById.keys()].filter((id) => !Object.values(mapper).includes(id))
    if (missingIds.length) problems.push(`${protoState}/${protoDir}: official ids not defined: ${missingIds.map((i) => `${i}=${reportById.get(i)}`).join(', ')}`)
  }
}

console.log(`\npacket id check: ${checked} packets compared`)
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):`)
  for (const p of problems) console.log('  ' + p)
  process.exitCode = 1
} else {
  console.log('PROBLEMS: none — every protocol.json packet id matches the official report')
}

const version = JSON.parse(await readFile(path.join(VENDOR, 'version.json'), 'utf8'))
console.log('vendor version.json:', JSON.stringify(version))
const blocks = JSON.parse(await readFile(path.join(VENDOR, 'blocks.json'), 'utf8'))
console.log('vendored blocks:', Array.isArray(blocks) ? blocks.length : Object.keys(blocks).length,
  'states:', (Array.isArray(blocks) ? blocks : Object.values(blocks)).reduce((n, b) => n + (b.maxStateId - b.minStateId + 1), 0))

