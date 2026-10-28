import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Vec3 } from 'vec3'

import {
  generateSchematicFile,
  parseBuildingSpec,
  readSchematicFile,
  summarizeSchematic,
  toSchematic,
} from '../lib/schematic-spec.js'
import { rotatePosition } from '../lib/builder.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE = path.join(HERE, '..', 'examples', 'small_house.json')

async function loadExample() {
  return JSON.parse(await readFile(EXAMPLE, 'utf8'))
}

test('structured JSON becomes a valid gzipped .schem and reads back identically', async () => {
  const spec = await loadExample()
  const outDir = await mkdtemp(path.join(tmpdir(), 'mc-companion-schem-'))
  const generated = await generateSchematicFile({ spec, version: '1.20.4', outDir })

  assert.equal(generated.name, 'small_house')
  assert.equal(generated.path, path.join(outDir, 'small_house.schem'))
  assert.equal(generated.size.x, 7)
  assert.equal(generated.size.y, 3)
  assert.equal(generated.size.z, 7)
  assert.equal(generated.solidBlocks, 121)
  assert.ok(generated.bytes > 40)
  assert.equal((await stat(generated.path)).size, generated.bytes)
  const jsonCopy = JSON.parse(await readFile(generated.jsonPath, 'utf8'))
  assert.equal(jsonCopy.name, 'small_house')
  assert.equal(jsonCopy._meta.version, '1.20.4')

  const { schematic } = await readSchematicFile(generated.path, '1.20.4')
  const summary = await summarizeSchematic(schematic)
  assert.deepEqual(summary.size, { x: 7, y: 3, z: 7 })
  assert.equal(summary.solidBlocks, 121)
  assert.equal(schematic.getBlock(new Vec3(0, 0, 0)).name, 'oak_planks')
  assert.equal(schematic.getBlock(new Vec3(0, 1, 0)).name, 'oak_log')
  assert.equal(schematic.getBlock(new Vec3(2, 1, 0)).name, 'glass')
  assert.equal(schematic.getBlock(new Vec3(2, 1, 6)).name, 'air') // door gap
  assert.equal(schematic.getBlock(new Vec3(3, 2, 3)).name, 'glass') // skylight
  assert.equal(summary.materials.oak_planks, 116) // 121 minus 2 logs, 3 glass
  assert.equal(summary.materials.oak_log, 2)
  assert.equal(summary.materials.glass, 3)
})

test('missing layers are filled with air instead of guessing', async () => {
  const parsed = parseBuildingSpec({
    name: 'pillar',
    size: { x: 1, y: 3, z: 1 },
    palette: { A: 'stone', '.': 'air' },
    layers: [{ y: 0, rows: ['A'] }],
  })
  assert.equal(parsed.solidBlocks, 1)
  const { schematic } = toSchematic(parsed, '1.20.4')
  assert.equal(schematic.getBlock(new Vec3(0, 0, 0)).name, 'stone')
  assert.equal(schematic.getBlock(new Vec3(0, 1, 0)).name, 'air')
  assert.equal(schematic.getBlock(new Vec3(0, 2, 0)).name, 'air')
})

test('spec validation rejects malformed input before any file is written', async () => {
  const base = {
    name: 'bad',
    size: { x: 3, y: 1, z: 1 },
    palette: { A: 'stone', '.': 'air' },
    layers: [{ y: 0, rows: ['AAA'] }],
  }
  assert.throws(() => parseBuildingSpec({ ...base, size: { x: 3, y: 1, z: 2 } }), /SPEC_INVALID_LAYERS/)
  assert.throws(() => parseBuildingSpec({ ...base, layers: [{ y: 0, rows: ['AA'] }] }), /SPEC_INVALID_LAYERS/)
  assert.throws(() => parseBuildingSpec({ ...base, layers: [{ y: 0, rows: ['AAX'] }] }), /SPEC_UNKNOWN_SYMBOL/)
  assert.throws(() => parseBuildingSpec({ ...base, palette: { A: 'stone[axis=y]' } }), /SPEC_UNSUPPORTED_BLOCK_STATE/)
  assert.throws(
    () => parseBuildingSpec({ ...base, palette: { '.': 'air' }, layers: [{ y: 0, rows: ['...'] }] }),
    /SPEC_EMPTY/,
  )
})

test('unknown block names fail at resolution with a suggestion', async () => {
  const spec = {
    name: 'typo',
    size: { x: 1, y: 1, z: 1 },
    palette: { A: 'oak_plankz', '.': 'air' },
    layers: [{ y: 0, rows: ['A'] }],
  }
  assert.throws(() => toSchematic(parseBuildingSpec(spec), '1.20.4'), /SPEC_UNKNOWN_BLOCK/)
})

test('oversized specs are refused', () => {
  assert.throws(
    () =>
      parseBuildingSpec(
        {
          name: 'huge',
          size: { x: 64, y: 64, z: 64 },
          palette: { A: 'stone', '.': 'air' },
          layers: [{ y: 0, rows: Array.from({ length: 64 }, () => 'A'.repeat(64)) }],
        },
        { maxBlocks: 1000 },
      ),
    /SPEC_TOO_LARGE/,
  )
})

test('rotation maps schematic coordinates around the origin', () => {
  const size = { x: 5, y: 1, z: 3 }
  assert.deepEqual(rotatePosition(new Vec3(0, 0, 0), size, 0), new Vec3(0, 0, 0))
  assert.deepEqual(rotatePosition(new Vec3(0, 0, 0), size, 90), new Vec3(2, 0, 0))
  assert.deepEqual(rotatePosition(new Vec3(4, 0, 0), size, 180), new Vec3(0, 0, 2))
  assert.deepEqual(rotatePosition(new Vec3(0, 0, 0), size, 270), new Vec3(0, 0, 4))
})
