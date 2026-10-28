/**
 * Structured building JSON -> Sponge `.schem` projection.
 *
 * The model emits a small, human-editable description:
 *
 * {
 *   "name": "small_house",
 *   "size": { "x": 7, "y": 5, "z": 7 },
 *   "palette": { "A": "minecraft:oak_planks", "B": "minecraft:glass", ".": "minecraft:air" },
 *   "layers": [{ "y": 0, "rows": ["AAAAAAA", "A.....A", ...] }]
 * }
 *
 * We validate it in code (never trust the model's dimensions), resolve block
 * state ids for the target Minecraft version, and write a real gzipped Sponge
 * v2 `.schem` file. No Python, no game client, no world edit.
 */

import minecraftData from 'minecraft-data'
import vec3Pkg from 'vec3'
import schematicPkg from 'prismarine-schematic'

const { Vec3 } = vec3Pkg
const { Schematic } = schematicPkg

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air', 'minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])
const MAX_SIDE = 64

/** Normalize a palette block name: strip namespace, keep plain names only. */
export function normalizeBlockName(name) {
  const raw = String(name ?? '').trim()
  if (!raw) throw new Error('SPEC_INVALID_BLOCK: 空的方块名')
  if (raw.includes('[') || raw.includes(']')) {
    throw new Error(`SPEC_UNSUPPORTED_BLOCK_STATE: "${raw}" 带方块状态，v1 只支持默认状态（如 minecraft:oak_stairs）`)
  }
  return raw.startsWith('minecraft:') ? raw.slice('minecraft:'.length) : raw
}

function assertInt(value, what, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`SPEC_INVALID_SIZE: ${what} 必须是 ${min}..${max} 的整数，收到 ${JSON.stringify(value)}`)
  }
}

/**
 * Validate a building spec and flatten it into a `y -> rows` grid.
 *
 * @param {unknown} input
 * @param {{ maxBlocks?: number, defaultName?: string }} [options]
 */
export function parseBuildingSpec(input, options = {}) {
  const maxBlocks = Number.isFinite(options.maxBlocks) ? Number(options.maxBlocks) : 32_768
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('SPEC_INVALID: spec 必须是一个对象（{name,size,palette,layers}）')
  }
  const spec = /** @type {Record<string, any>} */ (input)

  const sizeInput = spec.size
  if (!sizeInput || typeof sizeInput !== 'object') {
    throw new Error('SPEC_INVALID_SIZE: 缺少 size:{x,y,z}')
  }
  const x = Number(sizeInput.x)
  const y = Number(sizeInput.y)
  const z = Number(sizeInput.z)
  assertInt(x, 'size.x', 1, MAX_SIDE)
  assertInt(y, 'size.y', 1, MAX_SIDE)
  assertInt(z, 'size.z', 1, MAX_SIDE)
  const volume = x * y * z
  if (volume > maxBlocks) {
    throw new Error(`SPEC_TOO_LARGE: ${x}x${y}x${z} = ${volume} 格，超过上限 ${maxBlocks}`)
  }

  const paletteInput = spec.palette
  if (!paletteInput || typeof paletteInput !== 'object' || Array.isArray(paletteInput)) {
    throw new Error('SPEC_INVALID_PALETTE: 缺少 palette:{symbol:"minecraft:block"}')
  }
  /** @type {Record<string, string>} */
  const palette = {}
  for (const [key, value] of Object.entries(paletteInput)) {
    if (typeof key !== 'string' || key.length !== 1) {
      throw new Error(`SPEC_INVALID_PALETTE: 调色板键必须是单个字符，收到 ${JSON.stringify(key)}`)
    }
    const name = normalizeBlockName(value)
    palette[key] = name
  }
  if (Object.keys(palette).length === 0) throw new Error('SPEC_INVALID_PALETTE: palette 不能为空')
  if (!palette['.']) palette['.'] = 'air'

  /** @type {Map<number, string[][]>} layer y -> rows[z][x] */
  const layers = new Map()
  const rawLayers = spec.layers
  if (!Array.isArray(rawLayers) || rawLayers.length === 0) {
    throw new Error('SPEC_INVALID_LAYERS: 缺少非空 layers 数组')
  }
  for (const rawLayer of rawLayers) {
    if (!rawLayer || typeof rawLayer !== 'object') {
      throw new Error('SPEC_INVALID_LAYERS: layers 的每一项必须是 {y,rows}')
    }
    const layerY = Number(rawLayer.y)
    if (!Number.isInteger(layerY) || layerY < 0 || layerY >= y) {
      throw new Error(`SPEC_INVALID_LAYERS: 层 y=${JSON.stringify(rawLayer.y)} 超出 0..${y - 1}`)
    }
    if (layers.has(layerY)) throw new Error(`SPEC_INVALID_LAYERS: 重复的层 y=${layerY}`)
    const rows = rawLayer.rows
    if (!Array.isArray(rows) || rows.length !== z) {
      throw new Error(`SPEC_INVALID_LAYERS: y=${layerY} 需要 ${z} 行，收到 ${Array.isArray(rows) ? rows.length : JSON.stringify(rows)}`)
    }
    const normalizedRows = []
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]
      if (typeof row !== 'string') {
        throw new Error(`SPEC_INVALID_LAYERS: y=${layerY} 第 ${rowIndex} 行必须是字符串`)
      }
      if (row.length !== x) {
        throw new Error(`SPEC_INVALID_LAYERS: y=${layerY} 第 ${rowIndex} 行长度 ${row.length}，应为 ${x}`)
      }
      for (const char of row) {
        if (!(char in palette)) {
          throw new Error(`SPEC_UNKNOWN_SYMBOL: 符号 "${char}"（y=${layerY}, row=${rowIndex}）不在 palette 里`)
        }
      }
      normalizedRows.push(row)
    }
    layers.set(layerY, normalizedRows)
  }

  /** @type {string[][][]} grid[y][z][x] */
  const grid = []
  for (let layerY = 0; layerY < y; layerY += 1) {
    const rows = layers.get(layerY)
    const zRows = []
    for (let zi = 0; zi < z; zi += 1) {
      const xCells = []
      for (let xi = 0; xi < x; xi += 1) {
        const char = rows ? rows[zi][xi] : '.'
        xCells.push(palette[char])
      }
      zRows.push(xCells)
    }
    grid.push(zRows)
  }

  const name = typeof spec.name === 'string' && spec.name.trim() ? spec.name.trim() : (options.defaultName ?? 'untitled')
  let solid = 0
  const used = new Set()
  for (const layer of grid) {
    for (const row of layer) {
      for (const block of row) {
        if (!AIR_NAMES.has(block)) {
          solid += 1
          used.add(block)
        }
      }
    }
  }
  if (solid === 0) throw new Error('SPEC_EMPTY: spec 里没有任何非空气方块')

  return {
    name,
    size: { x, y, z },
    volume,
    palette,
    layers,
    grid,
    solidBlocks: solid,
    usedBlocks: [...used],
  }
}

/** Suggest a close block name for a typo, using a tiny edit distance. */
function suggestionsFor(name, mcData) {
  const target = name.toLowerCase()
  const candidates = Object.keys(mcData.blocksByName)
  const scored = []
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - target.length) > 3) continue
    let distance = 0
    const length = Math.min(candidate.length, target.length)
    for (let i = 0; i < length; i += 1) if (candidate[i] !== target[i]) distance += 1
    distance += Math.abs(candidate.length - target.length)
    if (distance <= 3) scored.push([distance, candidate])
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, 4)
    .map(([, candidate]) => candidate)
}

/**
 * Resolve block names to state ids for one Minecraft version.
 * @param {ReturnType<typeof parseBuildingSpec>} spec
 * @param {string} version
 */
export function resolveSchematic(spec, version) {
  let mcData
  try {
    mcData = minecraftData(version)
  } catch {
    throw new Error(`SPEC_UNSUPPORTED_VERSION: minecraft-data 不支持版本 ${version}（可在配置里改 schematicVersion）`)
  }
  if (!mcData) throw new Error(`SPEC_UNSUPPORTED_VERSION: minecraft-data 不支持版本 ${version}`)

  /** @type {Map<string, number>} */
  const stateIds = new Map()
  for (const name of spec.usedBlocks) {
    const block = mcData.blocksByName[name]
    if (!block) {
      const hint = suggestionsFor(name, mcData)
      throw new Error(`SPEC_UNKNOWN_BLOCK: 未知方块 "minecraft:${name}"（版本 ${version}）${hint.length ? `，是不是 ${hint.join(' / ')}?` : ''}`)
    }
    stateIds.set(name, block.defaultState)
  }
  const airState = mcData.blocksByName.air?.defaultState ?? 0
  return { mcData, stateIds, airState }
}

/**
 * Build a prismarine-schematic `Schematic` from a parsed spec.
 * @param {ReturnType<typeof parseBuildingSpec>} spec
 * @param {string} version
 */
export function toSchematic(spec, version) {
  const { stateIds, airState } = resolveSchematic(spec, version)
  const { x, y, z } = spec.size
  const palette = []
  const paletteIndex = new Map()
  const blocks = []
  let solid = 0

  const indexOf = (stateId) => {
    if (!paletteIndex.has(stateId)) {
      paletteIndex.set(stateId, palette.length)
      palette.push(stateId)
    }
    return paletteIndex.get(stateId)
  }

  // prismarine-schematic stores blocks in y, z, x order.
  for (let yi = 0; yi < y; yi += 1) {
    for (let zi = 0; zi < z; zi += 1) {
      for (let xi = 0; xi < x; xi += 1) {
        const name = spec.grid[yi][zi][xi]
        const isAir = AIR_NAMES.has(name)
        if (!isAir) solid += 1
        const stateId = isAir ? airState : stateIds.get(name)
        blocks.push(indexOf(stateId))
      }
    }
  }

  const schematic = new Schematic(version, new Vec3(x, y, z), new Vec3(0, 0, 0), palette, blocks)
  return {
    schematic,
    paletteNames: palette.map((stateId) => {
      if (stateId === airState) return 'minecraft:air'
      for (const [name, id] of stateIds) if (id === stateId) return `minecraft:${name}`
      return `state:${stateId}`
    }),
    solidBlocks: solid,
    version,
  }
}

/** Sanitize a user/model supplied file name. */
export function safeFileName(name) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 80)
  return cleaned || 'untitled'
}

/**
 * Generate a `.schem` file (and its JSON source) inside `outDir`.
 *
 * @param {{ spec: unknown, version: string, outDir: string, maxBlocks?: number, overwrite?: boolean, writeJson?: boolean }} options
 */
export async function generateSchematicFile(options) {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const parsed = parseBuildingSpec(options.spec, { maxBlocks: options.maxBlocks })
  const { schematic, paletteNames, solidBlocks } = toSchematic(parsed, options.version)
  const buffer = await schematic.write()

  await fs.mkdir(options.outDir, { recursive: true })
  const base = safeFileName(options.spec?.name ?? parsed.name)
  const fileName = `${base}.schem`
  const filePath = path.join(options.outDir, fileName)
  if (options.overwrite === false) {
    const exists = await fs
      .access(filePath)
      .then(() => true)
      .catch(() => false)
    if (exists) throw new Error(`SPEC_FILE_EXISTS: ${filePath} 已存在（传 overwrite:true 可覆盖）`)
  }
  await fs.writeFile(filePath, buffer)

  let jsonPath = null
  if (options.writeJson !== false) {
    jsonPath = path.join(options.outDir, `${base}.json`)
    await fs.writeFile(
      jsonPath,
      `${JSON.stringify({ ...options.spec, name: parsed.name, _meta: { version: options.version, generatedAt: new Date().toISOString(), solidBlocks } }, null, 2)}\n`,
      'utf8',
    )
  }

  return {
    name: parsed.name,
    path: filePath,
    jsonPath,
    bytes: buffer.length,
    version: options.version,
    size: parsed.size,
    volume: parsed.volume,
    solidBlocks,
    paletteNames,
    usedBlocks: parsed.usedBlocks,
    layerCount: parsed.layers.size,
  }
}

/**
 * Read a `.schem`/schematic file for building.
 * @param {string} filePath
 * @param {string} version
 */
export async function readSchematicFile(filePath, version) {
  const fs = await import('node:fs/promises')
  const buffer = await fs.readFile(filePath)
  let schematic
  try {
    schematic = await Schematic.read(buffer, version)
  } catch (error) {
    throw new Error(`SCHEMATIC_READ_FAILED: 无法读取 ${filePath}：${error instanceof Error ? error.message : String(error)}`)
  }
  return { schematic, buffer }
}

/** Human-readable summary of a loaded schematic. */
export async function summarizeSchematic(schematic) {
  const counts = new Map()
  let solid = 0
  let total = 0
  // prismarine-schematic's forEach is async: it awaits each callback.
  await schematic.forEach((block) => {
    total += 1
    if (block && block.name !== 'air' && block.name !== 'cave_air') {
      solid += 1
      counts.set(block.name, (counts.get(block.name) ?? 0) + 1)
    }
  })
  return {
    version: schematic.version,
    size: { x: schematic.size.x, y: schematic.size.y, z: schematic.size.z },
    volume: total,
    solidBlocks: solid,
    materials: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
  }
}

export { AIR_NAMES, MAX_SIDE }
