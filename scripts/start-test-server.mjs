#!/usr/bin/env node
/**
 * Start the disposable Paper test server and keep it in the foreground.
 *
 * Bound to 127.0.0.1 with online-mode=false; no production server is involved.
 * The Node integration test starts the same server through `test-server.mjs`.
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { RCON_PASSWORD, rconCommand } from './rcon.mjs'
import { fileURLToPath } from 'node:url'

export const RCON_PORT = 25580
export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.test-server')
export const JAR = path.join(SERVER_DIR, 'paper-1.20.4-499.jar')

/** Delete the disposable test worlds (only under .test-server). */
export async function resetWorld() {
  for (const name of ['world', 'world_the_end', 'world_nether']) {
    await rm(path.join(SERVER_DIR, name), { recursive: true, force: true })
  }
}

/** Wait until a port accepts TCP connections. */
export async function portOpen(port, host = '127.0.0.1', timeoutMs = 500) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
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
 * Start (or reuse) the test server.
 * @returns {Promise<{ port: number, external: boolean, stop: () => Promise<void>, write: (line: string) => void, logs: string[] }>}
 */
export async function startServer({ port = 25570, timeoutMs = 180_000, onLog, resetWorld: reset = false } = {}) {
  if (await portOpen(port)) {
    return {
      port,
      external: true,
      logs: [],
      write() {},
      async stop() {},
    }
  }
  if (reset) await resetWorld()

  // No piped stdio: restricted sandboxes forbid pipes to child processes, and a
  // Minecraft server already writes logs/latest.log. Readiness is detected by
  // tailing that file.
  const logFile = path.join(SERVER_DIR, 'logs', 'latest.log')
  let offset = 0
  try {
    offset = (await stat(logFile)).size
  } catch {
    /* first run */
  }

  const child = spawn('java', ['-Xms512M', '-Xmx1536M', '-jar', path.basename(JAR), '--nogui'], {
    cwd: SERVER_DIR,
    stdio: 'ignore',
    windowsHide: true,
  })

  const logs = []
  const push = (line) => {
    logs.push(line)
    if (logs.length > 400) logs.splice(0, logs.length - 400)
    onLog?.(line)
  }
  let ready = false

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null) {
      throw new Error(`test server exited early with code ${child.exitCode}\n${logs.slice(-30).join('\n')}`)
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
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!ready) {
    throw new Error(`test server did not start within ${timeoutMs}ms\n${logs.slice(-40).join('\n')}`)
  }

  const stop = async () => {
    if (child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    // No stdin without pipes; taskkill /T also reaps the forked server JVM.
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
    rconCommand({ port: RCON_PORT, password: RCON_PASSWORD, command: line }).catch((error) => {
      onLog?.(`[rcon] ${error.message}`)
    })
  }

  return { port, external: false, stop, write, logs }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startServer({ onLog: (line) => console.log(`[server] ${line}`) })
  console.log(`[server] ready at 127.0.0.1:${server.port}${server.external ? ' (existing)' : ''}`)
  process.on('SIGINT', async () => {
    await server.stop()
    process.exit(0)
  })
  await new Promise(() => {})
}






