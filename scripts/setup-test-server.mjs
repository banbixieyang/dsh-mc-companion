#!/usr/bin/env node
/**
 * Prepare a disposable local Minecraft server for the integration test.
 *
 * Downloads Paper (if missing), accepts the EULA for this local test world only,
 * and writes a flat, creative, offline-mode server.properties bound to
 * 127.0.0.1. It never touches the user's real servers.
 */
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureServerProperties, rconProperties } from './server-properties.mjs'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_DIR = path.resolve(HERE, '..', '.test-server')
export const JAR = path.join(SERVER_DIR, 'paper-1.20.4-499.jar')
const JAR_URL =
  'https://fill-data.papermc.io/v1/objects/cabed3ae77cf55deba7c7d8722bc9cfd5e991201c211665f9265616d9fe5c77b/paper-1.20.4-499.jar'

export const SERVER_PROPERTIES = {
  'server-ip': '127.0.0.1',
  'server-port': '25570',
  'online-mode': 'false',
  'enforce-secure-profile': 'false',
  'level-type': 'flat',
  'generator-settings':
    '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}',
  'level-name': 'world',
  'gamemode': 'creative',
  'force-gamemode': 'true',
  difficulty: 'peaceful',
  'spawn-protection': '0',
  'allow-flight': 'true',
  'allow-nether': 'false',
  'spawn-monsters': 'false',
  'spawn-animals': 'false',
  'spawn-npcs': 'false',
  'generate-structures': 'false',
  'view-distance': '6',
  'simulation-distance': '6',
  'max-players': '10',
  'motd': 'dsh-mc-companion test server',
  'enable-rcon': 'false',
  'sync-chunk-writes': 'false',
  'network-compression-threshold': '-1',
}

export async function exists(target) {
  return access(target)
    .then(() => true)
    .catch(() => false)
}

export async function downloadFile(url, target) {
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-mc-companion-test/0.1' } })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(target, buffer)
}

export async function prepareServer() {
  await mkdir(SERVER_DIR, { recursive: true })
  if (!(await exists(JAR))) {
    console.log(`[setup] downloading Paper 1.20.4 -> ${JAR}`)
    await downloadFile(JAR_URL, JAR)
  }
  await writeFile(path.join(SERVER_DIR, 'eula.txt'), 'eula=true\n', 'utf8')
  // Merge, so the RCON block the test harness needs survives a reused world.
  await ensureServerProperties(path.join(SERVER_DIR, 'server.properties'), {
    ...SERVER_PROPERTIES,
    ...rconProperties(25580)
  })
  return { dir: SERVER_DIR, jar: JAR }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await prepareServer()
  console.log(`[setup] ready: ${server.dir}`)
  console.log('[setup] start it with: node scripts/start-test-server.mjs')
}



