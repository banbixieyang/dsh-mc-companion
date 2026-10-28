#!/usr/bin/env node
/**
 * Download the vanilla 26.1 server jar (baseline for the 26.3 protocol diff).
 *
 * 26.3's Mojang reports are generated from the local 26.3 server jar; the diff
 * needs the same reports for 26.1. Everything lands in tools/mcdata263/baseline261.
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'baseline261')
const VERSION = process.argv[2] ?? '26.1'

async function download(url, file) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(file, buf)
  return buf.length
}

await mkdir(OUT, { recursive: true })

const manifest = await (await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).json()
const entry = manifest.versions.find((v) => v.id === VERSION)
if (!entry) throw new Error(`${VERSION} not in manifest`)

const meta = await (await fetch(entry.url)).json()
const server = meta.downloads?.server
if (!server) throw new Error('no server download in meta')
console.log(`${VERSION}: protocol ${meta.protocolVersion ?? '?'} -> ${server.url}`)

const bundler = path.join(OUT, `server-${VERSION}-bundler.jar`)
const size = await download(server.url, bundler)
console.log(`downloaded ${(size / 1e6).toFixed(1)} MB -> ${bundler}`)
await writeFile(path.join(OUT, 'meta.json'), JSON.stringify({ version: VERSION, url: server.url, size }, null, 2))
