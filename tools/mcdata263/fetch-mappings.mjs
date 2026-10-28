#!/usr/bin/env node
/**
 * Fetch Mojang's official mappings for a version and resolve class names.
 *
 * Usage: node fetch-mappings.mjs <version> [<out-dir>]
 *
 * The vanilla server/client jars are obfuscated; the mappings published in the
 * version manifest are the only way to locate a named class (e.g.
 * ClientboundPostEffectsPacket) inside them, which is what makes bytecode-level
 * verification of packet field order possible.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const version = process.argv[2] ?? '26.3'
const outDir = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, 'mappings', version))
await mkdir(outDir, { recursive: true })

const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json()
const entry = manifest.versions.find((v) => v.id === version)
if (!entry) throw new Error(`${version} not in manifest`)
const meta = await (await fetch(entry.url)).json()

for (const key of ['server_mappings', 'client', 'server']) {
  const dl = meta.downloads?.[key]
  if (!dl) { console.log(`${key}: absent`); continue }
  const file = path.join(outDir, `${key}.${key.endsWith('mappings') ? 'txt' : 'jar'}`)
  const res = await fetch(dl.url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(file, buf)
  console.log(`${key}: ${(buf.length / 1e6).toFixed(1)} MB -> ${file}`)
}
await writeFile(path.join(outDir, 'meta.json'), JSON.stringify({ version, id: meta.id, protocol: meta.protocolVersion }, null, 2))
