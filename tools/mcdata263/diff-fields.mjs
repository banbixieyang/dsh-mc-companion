#!/usr/bin/env node
/**
 * Deep diff between two Mojang report sets, ignoring protocol ids.
 *
 * Usage: node diff-fields.mjs <baseline-reports> <target-reports>
 *
 * Answers two questions that decide the shape of the 26.3 data patch:
 *  1. Which packets actually changed *shape* (not just their id)?
 *  2. Are existing block state ids stable (new blocks appended) or shifted?
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const read = async (dir, f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))
const [baseDir, tgtDir] = process.argv.slice(2).map((p) => path.resolve(p))
const bp = await read(baseDir, 'packets.json')
const tp = await read(tgtDir, 'packets.json')
const bb = await read(baseDir, 'blocks.json')
const tb = await read(tgtDir, 'blocks.json')

const strip = (o) => {
  const c = { ...o }
  delete c.protocol_id
  return c
}

console.log('=== packets whose definition changed (ids ignored) ===')
let n = 0
for (const state of Object.keys(tp)) {
  for (const dir of Object.keys(tp[state] ?? {})) {
    for (const [name, def] of Object.entries(tp[state][dir])) {
      if (name === 'protocol_id') continue
      const before = bp[state]?.[dir]?.[name]
      if (!before) continue
      const a = JSON.stringify(strip(before))
      const b = JSON.stringify(strip(def))
      if (a !== b) {
        n++
        console.log(`\n[${state}/${dir}] ${name}`)
        const fa = before.packet?.[0] ?? []
        const fb = def.packet?.[0] ?? []
        const ta = new Map(fa.map((f) => [f[0], f[1]]))
        const tb = new Map(fb.map((f) => [f[0], f[1]]))
        for (const [k, v] of tb) if (!ta.has(k)) console.log(`   + ${k}: ${JSON.stringify(v)}`)
        for (const [k, v] of ta) if (!tb.has(k)) console.log(`   - ${k}: ${JSON.stringify(v)}`)
        for (const [k, v] of tb) if (ta.has(k) && JSON.stringify(ta.get(k)) !== JSON.stringify(v)) console.log(`   ~ ${k}: ${JSON.stringify(ta.get(k))} -> ${JSON.stringify(v)}`)
        const extraA = Object.keys(strip(before)).filter((k) => k !== 'packet')
        if (extraA.length) console.log(`   (extra keys before: ${extraA.map((k) => `${k}=${JSON.stringify(before[k])}`).join(' ')})`)
        const extraB = Object.keys(strip(def)).filter((k) => k !== 'packet')
        if (extraB.length) console.log(`   (extra keys after: ${extraB.map((k) => `${k}=${JSON.stringify(def[k])}`).join(' ')})`)
      }
    }
  }
}
console.log(`\ntotal reshaped packets: ${n}`)

console.log('\n=== block state id stability ===')
let stable = 0
let shifted = 0
const shiftSamples = []
for (const name of Object.keys(bb)) {
  if (!tb[name]) continue
  const a = Object.values(bb[name].states ?? {}).map((s) => s.id)
  const b = Object.values(tb[name].states ?? {}).map((s) => s.id)
  const first = b[0] ?? null
  if (JSON.stringify(a) === JSON.stringify(b)) stable++
  else {
    shifted++
    if (shiftSamples.length < 8) shiftSamples.push(`${name}: first ${a[0]} -> ${first} (${a.length} states)`)
  }
}
console.log(`  identical state id lists: ${stable}`)
console.log(`  changed: ${shifted}`)
shiftSamples.forEach((s) => console.log(`   ${s}`))

// where do the new blocks' state ids live?
const maxOld = Math.max(...Object.values(bb).flatMap((b) => Object.values(b.states ?? {}).map((s) => s.id)))
const newBlocks = Object.keys(tb).filter((k) => !bb[k])
const newIds = newBlocks.flatMap((k) => Object.values(tb[k].states ?? {}).map((s) => s.id))
console.log(`  max state id (26.1): ${maxOld}; new blocks' ids: min ${Math.min(...newIds)} max ${Math.max(...newIds)}`)
