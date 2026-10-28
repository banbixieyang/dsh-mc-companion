#!/usr/bin/env node
/**
 * Install the pieces the live view needs.
 *
 * prismarine-viewer builds its block texture atlas with `node-canvas`, which is
 * a native module and needs a compiler toolchain (not available on every
 * machine, and blocked in sandboxes that cannot spawn node-gyp). @napi-rs/canvas
 * is a prebuilt N-API implementation with the same createCanvas / Canvas /
 * Image surface, so we install it and expose it under the name `canvas` via
 * vendor/canvas-shim.
 *
 * Idempotent: safe to run again after `npm install`.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = path.resolve(import.meta.dirname, '..')
const require = createRequire(path.join(root, 'package.json'))

const has = (name) => {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

async function install (packages) {
  const missing = packages.filter((name) => !has(name))
  if (missing.length === 0) {
    console.log(`already installed: ${packages.join(', ')}`)
    return
  }
  console.log(`installing: ${missing.join(', ')}`)
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', ...missing, '--no-audit', '--no-fund'], {
    cwd: root,
    env: { ...process.env, npm_config_cache: path.join(root, '..', '.npm-cache') },
    maxBuffer: 16 * 1024 * 1024
  })
}

await install(['prismarine-viewer', '@napi-rs/canvas'])

// Expose @napi-rs/canvas as `canvas` for prismarine-viewer.
const shimTarget = path.join(root, 'node_modules', 'canvas')
await mkdir(shimTarget, { recursive: true })
await cp(path.join(root, 'vendor', 'canvas-shim', 'index.js'), path.join(shimTarget, 'index.js'), { force: true })
await writeFile(
  path.join(shimTarget, 'package.json'),
  JSON.stringify({ name: 'canvas', version: '0.0.0-shim', main: 'index.js', private: true }, null, 2)
)
console.log('canvas shim installed')

// Smoke test: both modules must load, otherwise the panel button leads nowhere.
const { mineflayer } = require('prismarine-viewer')
const canvas = require('canvas')
console.log(`prismarine-viewer ready (${typeof mineflayer}), canvas shim ready (${typeof canvas.createCanvas})`)

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
console.log(`dependencies: ${JSON.stringify(pkg.dependencies ?? {}, null, 0)}`)
