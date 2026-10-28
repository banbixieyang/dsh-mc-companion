#!/usr/bin/env node
/**
 * Diff Mojang's data reports between two Minecraft versions.
 *
 * Usage: node diff.mjs <baseline-reports-dir> <target-reports-dir>
 *
 * Reports the exact protocol surface change (packets added/removed/reshaped),
 * block/item/registry id shifts. This decides whether 26.3 can be expressed as
 * a small patch on the 26.1 protodef definitions or needs a full rebuild.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const read = async (dir, f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))
const [baseDir, tgtDir] = process.argv.slice(2).map((p) => path.resolve(p))
const base = { packets: await read(baseDir, 'packets.json'), blocks: await read(baseDir, 'blocks.json'), regs: await read(baseDir, 'registries.json') }
const tgt = { packets: await read(tgtDir, 'packets.json'), blocks: await read(tgtDir, 'blocks.json'), regs: await read(tgtDir, 'registries.json') }

const flat = (packets) => {
  const out = {}
  for (const [state, dirs] of Object.entries(packets)) {
    for (const [dir, body] of Object.entries(dirs)) {
      for (const [name, def] of Object.entries(body)) {
        if (name === 'protocol_id') continue
        out[`${state}/${dir}/${name}`] = def
      }
    }
  }
  return out
}

console.log('=== packet registry shape ===')
for (const [state, dirs] of Object.entries(tgt.packets)) {
  const parts = Object.entries(dirs).map(([d, b]) => `${d}:${Object.keys(b).filter((k) => k !== 'protocol_id').length}`)
  console.log(`  ${state}: ${parts.join(' ')}`)
}

const a = flat(base.packets)
const b = flat(tgt.packets)
const added = Object.keys(b).filter((k) => !(k in a))
const removed = Object.keys(a).filter((k) => !(k in b))
const common = Object.keys(b).filter((k) => k in a)
const changed = common.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))

console.log('\n=== packets ===')
console.log(`  baseline ${Object.keys(a).length}  target ${Object.keys(b).length}`)
console.log(`  added ${added.length}: ${added.join(', ') || '(none)'}`)
console.log(`  removed ${removed.length}: ${removed.join(', ') || '(none)'}`)
console.log(`  changed ${changed.length}: ${changed.join(', ') || '(none)'}`)

console.log('\n=== id moves (same packet, different id) ===')
for (const k of common) {
  const [state, dir, name] = k.split('/')
  const ia = base.packets[state]?.[dir]?.[name]?.protocol_id
  const ib = tgt.packets[state]?.[dir]?.[name]?.protocol_id
  if (ia !== ib) console.log(`  ${k}: ${ia} -> ${ib}`)
}

console.log('\n=== blocks ===')
const ba = new Set(Object.keys(base.blocks))
const bb = new Set(Object.keys(tgt.blocks))
const newBlocks = [...bb].filter((x) => !ba.has(x))
console.log(`  baseline ${ba.size} target ${bb.size} new ${newBlocks.length}`)
console.log(`  new: ${newBlocks.join(', ') || '(none)'}`)
const stateCount = (blocks) => Object.values(blocks).reduce((n, b) => n + Object.keys(b.states ?? {}).length, 0)
console.log(`  block states: ${stateCount(base.blocks)} -> ${stateCount(tgt.blocks)}`)

console.log('\n=== registries (added entries / id shifts) ===')
for (const [name, reg] of Object.entries(tgt.regs)) {
  const before = base.regs[name]
  if (!before) { console.log(`  NEW registry ${name}: ${Object.keys(reg.entries ?? {}).length} entries`); continue }
  const ea = Object.values(before.entries ?? {})
  const eb = Object.values(reg.entries ?? {})
  const idsA = new Map(ea.map((e) => [e.protocol_id, 1]))
  const nowIds = new Set(eb.map((e) => e.protocol_id))
  const addedEntries = eb.filter((e) => !ea.some((x) => x.protocol_id === e.protocol_id) || true)
  const shift = ea.filter((e) => {
    const t = eb.find((x) => x.protocol_id === e.protocol_id)
    return t && t.protocol_id !== e.protocol_id
  })
  const nameDiff = eb.length - ea.length
  const removedIds = [...idsA.keys()].filter((id) => !nowIds.has(id))
  if (nameDiff !== 0 || removedIds.length) {
    console.log(`  ${name}: ${ea.length} -> ${eb.length} (added ${Math.max(0, nameDiff)}, removed ids ${removedIds.length})`)
  }
}
