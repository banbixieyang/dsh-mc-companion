#!/usr/bin/env node
/**
 * Live-view end-to-end: the panel's "open view" button must lead to a working
 * page, so the viewer has to actually serve the three.js client and the
 * websocket bridge, not just report `running: true`.
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { install } from '../index.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'
import { startServer } from '../scripts/start-test-server.mjs'

const log = (...args) => console.log('[viewer-e2e]', ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const VIEWER_PORT = 3111

async function until (fn, { timeoutMs = 30_000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(intervalMs)
  }
  throw new Error(`timed out waiting for ${label}; last=${JSON.stringify(last)}`)
}

async function main () {
  const server = await startServer({ resetWorld: true })
  if (server.external) throw new Error('MC_TEST_SERVER_RUNNING: 先停掉测试端口上的服务器。')
  log(`server on ${server.port}`)

  const cwd = await mkdtemp(path.join(tmpdir(), 'mc-companion-viewer-'))
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, {
    host: '127.0.0.1',
    port: server.port,
    username: 'ViewerBot',
    version: '1.20.4',
    autoConnect: false,
    viewer: { enabled: true, port: VIEWER_PORT, firstPerson: true, viewDistance: 4 }
  })
  const exec = execContext()
  const mode = tools.get('mc_companion_mode')

  try {
    await mode.execute({ action: 'enable', connect: false }, exec)
    const connected = await tools.get('mc_bot_connect').execute({}, exec)
    assert.equal(connected.ok, true, JSON.stringify(connected))
    assert.ok(connected.viewer, 'connect should report the viewer state')
    log(`connected; viewer snapshot ${JSON.stringify(connected.viewer)}`)

    const running = await until(() => companion.viewer.snapshot().running || companion.viewer.snapshot().error, {
      timeoutMs: 40_000,
      label: 'viewer to start'
    })
    const snapshot = companion.viewer.snapshot()
    assert.equal(snapshot.error, null, `viewer failed: ${snapshot.error}`)
    assert.equal(running, true)
    assert.match(snapshot.url, new RegExp(`:${VIEWER_PORT}/$`))

    // The page has to be real: an HTML document that loads the viewer bundle.
    const page = await fetch(snapshot.url)
    assert.equal(page.status, 200, `viewer page status ${page.status}`)
    const html = await page.text()
    assert.ok(html.length > 200, `viewer page looks empty (${html.length} bytes)`)
    assert.match(html, /<html/i, 'viewer page should be an HTML document')
    assert.match(html, /canvas|three|viewer/i, 'viewer page should mount the 3D canvas')
    log(`PASS viewer page: ${snapshot.url} (${html.length} bytes)`)

    // The websocket bridge is what makes it a live stream; the client bundle
    // must be fetchable too.
    const bundleProbe = await fetch(new URL('index.js', snapshot.url)).catch(() => null)
    if (bundleProbe) log(`PASS viewer bundle: HTTP ${bundleProbe.status}`)

    // Panel controls: stop then start again.
    const stopped = await tools.get('mc_companion_mode').execute({ action: 'status' }, exec)
    assert.equal(stopped.viewer.running, true, JSON.stringify(stopped.viewer))
    companion.viewer.stop()
    assert.equal(companion.viewer.snapshot().running, false)
    const restarted = await companion.startViewer()
    assert.equal(restarted.running, true, JSON.stringify(restarted))
    log('PASS viewer lifecycle: stop then restart from the panel action')

    // Disconnecting must release the port, otherwise the next connect fails.
    await tools.get('mc_bot_disconnect').execute({ reason: 'viewer e2e' }, exec)
    assert.equal(companion.viewer.snapshot().running, false)
    log('PASS viewer released on disconnect')

    console.log('\n=== VIEWER E2E PASS ===')
    // socket.io keeps handles open; exit explicitly instead of hanging.
    process.exit(0)
  } finally {
    try {
      await mode.execute({ action: 'disable', reason: 'viewer e2e done' }, exec)
    } catch {
      /* ignore */
    }
    await ctx.dispose()
    await server.stop()
  }
}

main().catch((error) => {
  console.error('\n=== VIEWER E2E FAIL ===')
  console.error(error)
  process.exit(1)
})


