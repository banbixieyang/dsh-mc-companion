/**
 * server.properties helper.
 *
 * The test servers must survive being created once and reused: settings such as
 * the RCON block are needed by the harness on every run, while the server may
 * have rewritten or expanded the file in between. Merging (instead of
 * overwriting) keeps the server's own values for keys we do not manage.
 */
import { readFile, writeFile } from 'node:fs/promises'

import { RCON_PASSWORD } from './rcon.mjs'

export { RCON_PASSWORD }

/** The RCON block every local test server needs (the harness drives the console). */
export function rconProperties (port) {
  return {
    'enable-rcon': 'true',
    'rcon.port': String(port),
    'rcon.password': RCON_PASSWORD,
    'broadcast-rcon-to-ops': 'false'
  }
}

/**
 * Merge `overrides` into server.properties, creating it when absent.
 * @param {string} file absolute path to server.properties
 * @param {Record<string, string | number>} overrides
 */
export async function ensureServerProperties (file, overrides) {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    /* first run */
  }
  const values = new Map()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    values.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1))
  }
  for (const [key, value] of Object.entries(overrides)) values.set(key, String(value))
  const body = [...values.entries()].map(([key, value]) => `${key}=${value}`).join('\n')
  await writeFile(file, `${body}\n`, 'utf8')
}


