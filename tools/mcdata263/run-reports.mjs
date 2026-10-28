#!/usr/bin/env node
/**
 * Run Mojang's data generator (`--reports`) on a vanilla server bundler jar.
 *
 * Usage: node run-reports.mjs <bundler-jar> <out-dir>
 *
 * The jar is Mojang's bundler (Main-Class net.minecraft.bundler.Main); the real
 * server jar plus libraries are resolved by it, so `-DbundlerMainClass` is the
 * only reliable entry point. Spawned through node so the argument is never
 * mangled by a shell.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const [jarArg, outArg] = process.argv.slice(2)
if (!jarArg || !outArg) {
  console.error('usage: node run-reports.mjs <bundler-jar> <out-dir>')
  process.exit(2)
}
const jar = path.resolve(jarArg)
const out = path.resolve(outArg)
await mkdir(out, { recursive: true })

const JAVA_CANDIDATES = [
  process.env.MC_JAVA25,
  'C:\\Program Files\\Java\\jdk-26.0.2\\bin\\java.exe',
  'C:\\Program Files\\Java\\jdk-25.0.2\\bin\\java.exe',
  'C:\\Program Files\\Java\\jdk-25\\bin\\java.exe',
].filter(Boolean)
const java = JAVA_CANDIDATES.find((p) => existsSync(p))
if (!java) throw new Error('no JDK 25/26 found; set MC_JAVA25')

const res = spawnSync(
  java,
  ['-Xmx3G', '-DbundlerMainClass=net.minecraft.data.Main', '-jar', jar, '--reports', '--output', out],
  { stdio: 'inherit' }
)
if (res.status !== 0) {
  throw new Error(`data generator failed: status=${res.status} signal=${res.signal}`)
}
const reports = path.join(out, 'reports')
const files = ['blocks.json', 'registries.json', 'packets.json', 'commands.json']
for (const f of files) {
  const p = path.join(reports, f)
  if (!existsSync(p)) throw new Error(`missing report ${f}`)
  const json = JSON.parse(await readFile(p, 'utf8'))
  const size = typeof json === 'object' ? Object.keys(json).length : 0
  console.log(`${f}: ${size} top-level keys`)
}
console.log(`reports -> ${reports}`)
