#!/usr/bin/env node
/**
 * Minimal asar reader: find the module that implements install_bundle /
 * remove_bundle inside DSH's app.asar, so the bundle re-install can be driven
 * the same way the plugin manager does it.
 *
 * Usage: node tools/asar-find.mjs <app.asar> <searchString> [maxHits]
 */
import { open } from 'node:fs/promises'
import path from 'node:path'

const asarPath = path.resolve(process.argv[2] ?? '')
const needle = process.argv[3] ?? 'install_bundle'
const maxHits = Number(process.argv[4] ?? 6)

const handle = await open(asarPath, 'r')
const { size } = await handle.stat()
const head = Buffer.alloc(16)
await handle.read(head, 0, 16, 0)
const [headerSize] = head.readUInt32LE(0) === 4 ? [head.readUInt32LE(4)] : [head.readUInt32LE(0)]
const jsonSize = head.readUInt32LE(0) === 4 ? head.readUInt32LE(4) : head.readUInt32LE(0)
const headerBuf = Buffer.alloc(jsonSize)
await handle.read(headerBuf, 0, jsonSize, 8)
const header = JSON.parse(headerBuf.toString('utf8'))
const dataOffset = 8 + headerSize

/** Walk the asar header tree into a flat list of {path, offset, size}. */
function walk (node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, full, out)
    else if (entry.size !== undefined) out.push({ path: full, offset: Number(entry.offset), size: entry.size })
  }
}
const files = []
walk(header, '', files)
console.log(`asar: ${size} bytes, ${files.length} entries, data offset ${dataOffset}`)

const candidates = files.filter((file) => /\.(js|mjs|cjs)$/.test(file.path))
const hits = []
for (const file of candidates) {
  if (file.size > 4 * 1024 * 1024) continue
  const buf = Buffer.alloc(file.size)
  await handle.read(buf, 0, file.size, dataOffset + file.offset)
  const text = buf.toString('utf8')
  if (text.includes(needle)) hits.push({ ...file, text })
  if (hits.length >= maxHits) break
}
for (const hit of hits) {
  console.log(`\n=== ${hit.path} (${hit.size} bytes) ===`)
  const index = hit.text.indexOf(needle)
  console.log(hit.text.slice(Math.max(0, index - 400), index + 400).replace(/\s+/g, ' '))
}
if (hits.length === 0) console.log(`no file contains ${needle}`)
await handle.close()
