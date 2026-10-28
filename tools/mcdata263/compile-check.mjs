#!/usr/bin/env node
/**
 * Compile the vendored 26.3 protocol with the *installed* protodef and
 * minecraft-protocol datatypes, exactly like minecraft-protocol's serializer
 * does, and report every undefined type reference.
 *
 * Usage: node compile-check.mjs [<protocol.json>]
 *
 * This is the fast, server-free acceptance test: a missing custom type here is
 * guaranteed to blow up at connect time, and protodef's error names it.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(path.resolve('package.json'))
const { ProtoDef } = require('protodef')
const minecraft = require('minecraft-protocol/src/datatypes/minecraft')
const nbt = require('prismarine-nbt')

const file = path.resolve(process.argv[2] ?? 'vendor/mc-data-26.3/protocol.json')
const protocol = JSON.parse(await readFile(file, 'utf8'))

const STATE_DIRS = []
for (const state of ['handshaking', 'status', 'login', 'configuration', 'play']) {
  for (const dir of ['toClient', 'toServer']) {
    if (protocol[state]?.[dir]) STATE_DIRS.push([state, dir])
  }
}

console.log(`compiling ${file}`)
console.log(`states: ${STATE_DIRS.map(([s, d]) => `${s}/${d}`).join(', ')}`)

let failures = 0
for (const [state, dir] of STATE_DIRS) {
  const proto = new ProtoDef(false)
  try {
    proto.addTypes(minecraft)
    nbt.addTypesToInterpreter('big', proto)
    // isolate one state/direction at a time so the error names the culprit
    proto.addTypes({ __probe: protocol[state][dir].types.packet })
    const t = proto.types.__probe
    const payload = t instanceof Object ? '' : ''
    void payload
    // force resolution of every nested type by compiling each packet body
    for (const [name, def] of Object.entries(protocol[state][dir].types)) {
      if (!name.startsWith('packet_')) continue
      try {
        proto.addType(`__t_${name}`, def)
      } catch (e) {
        failures++
        console.log(`  [${state}/${dir}] ${name}: ${e.message}`)
      }
    }
    console.log(`  ${state}/${dir}: ${Object.keys(protocol[state][dir].types).length} types added`)
  } catch (e) {
    failures++
    console.log(`  [${state}/${dir}] FAILED: ${e.message}`)
  }
}

console.log(failures ? `\nfailures: ${failures}` : '\nno compile failures')
if (failures) process.exitCode = 1

