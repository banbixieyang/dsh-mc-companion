#!/usr/bin/env node
/**
 * Parse a saved `javap -p -c` dump and list ViaVersion's packet registrations.
 *
 * Usage: node via-handlers.mjs <javap-dump.txt>
 *
 * ViaVersion only registers handlers for packets whose *shape* changed between
 * two versions, so this list is the authoritative "what actually changed"
 * contract for a protocol delta: `appendX` adds a handler to an existing
 * mapping, `replaceX` means the payload is rewritten wholesale.
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const target = process.argv[2]
if (!target) {
  console.error('usage: node via-handlers.mjs <javap-dump.txt|dir>')
  process.exit(2)
}

const stat = await readdir(path.resolve(target)).then(() => 'dir').catch(() => 'file')
const files = stat === 'dir'
  ? (await readdir(path.resolve(target))).filter((f) => f.endsWith('.txt')).map((f) => path.join(path.resolve(target), f))
  : [path.resolve(target)]

for (const file of files) {
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/)
  const regs = []
  let pending = null
  for (const raw of lines) {
    const line = raw.replace(/^ {0,8}\d+:\s*/, '')
    const get = line.match(/getstatic.*\/packet\/(\w+)\.([A-Za-z0-9_]+):/)
    if (get) { pending = { enum: get[1], packet: get[2] }; continue }
    const call = line.match(/(?:Method|InterfaceMethod)\s+(\w+):/)
    if (call && pending && /^(append|replace|prepend|register)/i.test(call[1])) {
      regs.push({ ...pending, kind: call[1] })
      pending = null
    }
  }
  console.log(`--- ${path.basename(file)} ---`)
  const seen = new Set()
  for (const r of regs) {
    const key = `${r.kind}:${r.enum}.${r.packet}`
    if (seen.has(key)) continue
    seen.add(key)
    console.log(`${r.kind.padEnd(20)} ${r.enum}.${r.packet}`)
  }
  console.log(`(${regs.length} registrations, ${seen.size} unique)\n`)
}
