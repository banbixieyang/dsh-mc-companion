#!/usr/bin/env node
/**
 * Disposable Minecraft **26.3** server with ViaVersion + ViaBackwards.
 *
 * Purpose: validate the only currently workable 26.3 path — a 26.1 bot behind
 * ViaBackwards — without touching a real server. It downloads Paper 26.3 and
 * the two Via jars, finds a local Java 25, and writes a flat creative
 * offline-mode server on 127.0.0.1:25566.
 *
 * Requires Java 25 (Minecraft 26.3 minimum). Discovery order:
 *   MC_JAVA25 env var → Gradle toolchains → C:\Program Files\Java\jdk-25*.
 */
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { ensureServerProperties, rconProperties } from './server-properties.mjs'
import { RCON_PASSWORD, rconCommand } from './rcon.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_263_DIR = path.resolve(HERE, '..', '.test-server-26')
export const PAPER_263_JAR = path.join(SERVER_263_DIR, 'paper-26.3-226.jar')
export const PAPER_263_URL =
  'https://fill-data.papermc.io/v1/objects/1373c651510d4aeee7e7903f3cfd7003919c1a364528dbe124a4ae40e11a766e/paper-26.3-226.jar'
export const VIA_JARS = {
  'ViaVersion-5.12.1.jar':
    'https://hangarcdn.papermc.io/plugins/ViaVersion/ViaVersion/versions/5.12.1/PAPER/ViaVersion-5.12.1.jar',
  'ViaBackwards-5.12.1.jar':
    'https://hangarcdn.papermc.io/plugins/ViaVersion/ViaBackwards/versions/5.12.1/PAPER/ViaBackwards-5.12.1.jar',
}
export const PORT_263 = 25566
export const RCON_PORT_263 = 25576

const PROPERTIES = {
  'server-ip': '127.0.0.1',
  'server-port': String(PORT_263),
  'online-mode': 'false',
  'white-list': 'false',
  'enforce-whitelist': 'false',
  'enforce-secure-profile': 'false',
  'level-type': 'flat',
  'generator-settings':
    '{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:dirt","height":2},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains"}',
  'level-name': 'world',
  gamemode: 'creative',
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
  motd: 'dsh-mc-companion 26.3 via test',
  'enable-rcon': 'false',
  'sync-chunk-writes': 'false',
  'network-compression-threshold': '-1',
}

async function exists(target) {
  return access(target)
    .then(() => true)
    .catch(() => false)
}

async function download(url, target) {
  if (await exists(target)) return
  const response = await fetch(url, { headers: { 'User-Agent': 'dsh-mc-companion-test/0.1' } })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status} ${url}`)
  await writeFile(target, Buffer.from(await response.arrayBuffer()))
}

function javaMajor(java) {
  // java -version writes to stderr on every platform; capture both.
  const result = spawnSync(java, ['-version'], { encoding: 'utf8' })
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const match = /version "(\d+)/.exec(text)
  return match ? Number(match[1]) : null
}

/**
 * Detect a JDK's major version without spawning it: every JDK 9+ keeps a
 * `release` file next to `bin` (`JAVA_VERSION="26.0.2"`). Spawning `java
 * -version` would need piped stdio, which restricted sandboxes forbid.
 */
async function javaMajorAt(home) {
  try {
    const release = await readFile(path.join(home, 'release'), 'utf8')
    const match = /JAVA_VERSION="(\d+)/.exec(release)
    if (match) return Number(match[1])
  } catch {
    /* no release file, fall back to the directory name */
  }
  const match = /(?:jdk-?|jdk)(\d+)/i.exec(path.basename(home))
  return match ? Number(match[1]) : null
}

/**
 * Find a local Java runtime new enough for 26.3 (official requirement: Java 25;
 * newer works too — this repo's data generation runs on Java 26).
 */
export async function findJava25() {
  const explicit = process.env.MC_JAVA25
  if (explicit) {
    const home = path.basename(explicit).toLowerCase().startsWith('java') ? path.dirname(path.dirname(explicit)) : explicit
    if (await exists(explicit)) return explicit
    if (await exists(path.join(explicit, 'bin', 'java.exe'))) return path.join(explicit, 'bin', 'java.exe')
    void home
  }

  const roots = [
    path.join(process.env.USERPROFILE ?? 'C:\\Users\\Lenovo', '.gradle', 'jdks'),
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft'
  ]
  if (process.env.JAVA_HOME) roots.unshift(path.dirname(process.env.JAVA_HOME))

  let best = null
  let bestMajor = 0
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const home = path.join(root, entry)
      const exe = path.join(home, 'bin', 'java.exe')
      if (!(await exists(exe))) continue
      const major = await javaMajorAt(home)
      if (major === null || major < 25) continue
      if (major > bestMajor) {
        best = exe
        bestMajor = major
      }
    }
  }
  if (best) return best
  throw new Error(
    'MC_JAVA25_MISSING: Minecraft 26.3 needs Java 25 or newer. Set MC_JAVA25 to such a binary (Gradle toolchains often have one).',
  )
}

/** Download jars and write eula/server.properties. */
export async function prepareServer263({ resetWorld = false, via = !process.env.MC_NO_VIA, extraProperties = {} } = {}) {
  await mkdir(path.join(SERVER_263_DIR, 'plugins'), { recursive: true })
  await download(PAPER_263_URL, PAPER_263_JAR)
  if (via) {
    for (const [name, url] of Object.entries(VIA_JARS)) {
      await download(url, path.join(SERVER_263_DIR, 'plugins', name))
    }
  } else {
    // Native-26.3 runs must not have a translation layer in front of the bot.
    for (const name of Object.keys(VIA_JARS)) {
      await rm(path.join(SERVER_263_DIR, 'plugins', name), { force: true })
    }
  }
  await writeFile(path.join(SERVER_263_DIR, 'eula.txt'), 'eula=true\n', 'utf8')
  // Merge so the RCON block the test harness needs survives a reused world
  // (and so the server's own expanded properties are preserved).
  await ensureServerProperties(path.join(SERVER_263_DIR, 'server.properties'), {
    ...PROPERTIES,
    ...rconProperties(RCON_PORT_263),
    ...extraProperties
  })
  if (resetWorld) {
    for (const name of ['world', 'world_nether', 'world_the_end']) {
      await rm(path.join(SERVER_263_DIR, name), { recursive: true, force: true })
    }
  }
  return { dir: SERVER_263_DIR, jar: PAPER_263_JAR, java: await findJava25() }
}

export async function portOpen263(timeoutMs = 500) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT_263 })
    const done = (value) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Start (or reuse) the 26.3 test server.
 * @returns {Promise<{ port: number, external: boolean, stop: () => Promise<void>, write: (line: string) => void, logs: string[] }>}
 */
export async function startServer263({ timeoutMs = 180_000, onLog, resetWorld = false, extraProperties = {} } = {}) {
  if (await portOpen263()) {
    return { port: PORT_263, external: true, logs: [], write() {}, async stop() {} }
  }
  const { java, jar } = await prepareServer263({ resetWorld, extraProperties })
  // No piped stdio: restricted sandboxes forbid pipes to child processes, and a
  // Minecraft server already writes logs/latest.log. Readiness is detected by
  // tailing that file.
  const logFile = path.join(SERVER_263_DIR, 'logs', 'latest.log')
  let offset = 0
  try {
    offset = (await stat(logFile)).size
  } catch {
    /* first run */
  }
  const child = spawn(java, ['-Xms512M', '-Xmx2G', '-jar', path.basename(jar), '--nogui'], {
    cwd: SERVER_263_DIR,
    stdio: 'ignore',
    windowsHide: true,
  })
  const logs = []
  const push = (line) => {
    logs.push(line)
    if (logs.length > 400) logs.splice(0, logs.length - 400)
    onLog?.(line)
  }

  const deadline = Date.now() + timeoutMs
  let ready = false
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`26.3 server exited early with code ${child.exitCode}\n${logs.slice(-30).join('\n')}`)
    }
    try {
      const text = await readFile(logFile, 'utf8')
      // Paper rotates latest.log on startup: a shorter file means a new log.
      if (text.length < offset) offset = 0
      if (text.length > offset) {
        const chunk = text.slice(offset)
        offset = text.length
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.trim()) continue
          push(line)
          if (/Done \([\d.]+s\)! For help/.test(line)) ready = true
        }
      }
    } catch {
      /* log not written yet */
    }
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!ready) {
    throw new Error(`26.3 server did not start within ${timeoutMs}ms\n${logs.slice(-40).join('\n')}`)
  }

  const stop = async () => {
    if (child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    // taskkill with /T also reaps the forked server JVM (bundler spawns it).
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, 15_000)
    await exited
    clearTimeout(timer)
  }
  const write = (line) => {
    // No stdin without pipes; drive the server console over RCON instead.
    rconCommand({ port: RCON_PORT_263, password: RCON_PASSWORD, command: line }).catch((error) => {
      onLog?.(`[rcon] ${error.message}`)
    })
  }
  return { port: PORT_263, external: false, stop, write, logs }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer263({ onLog: (line) => console.log(`[server-26] ${line}`) })
  console.log(`[server-26] ready at 127.0.0.1:25566${server.external ? ' (existing)' : ''}`)
  await new Promise(() => {})
}





