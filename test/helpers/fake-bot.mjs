import { Vec3 } from 'vec3'

const key = (pos) => `${pos.x},${pos.y},${pos.z}`

function block(name, position) {
  return {
    name,
    position: position.clone(),
    boundingBox: name === 'air' ? 'empty' : 'block',
    diggable: name !== 'air' && name !== 'bedrock',
  }
}

/**
 * A tiny in-memory Mineflayer stand-in: just enough surface for the builder.
 * It deliberately does not emulate physics or inventories beyond what the
 * builder reads.
 */
export function createFakeBot({ origin = new Vec3(10, 64, 10), size = { x: 9, y: 5, z: 9 }, gear = {} } = {}) {
  const world = new Map()
  const inventory = []
  let currentItem = null

  // Ground plane so the first layer has a face to place against.
  for (let x = origin.x - 2; x < origin.x + size.x + 2; x += 1) {
    for (let z = origin.z - 2; z < origin.z + size.z + 2; z += 1) {
      const pos = new Vec3(x, origin.y - 1, z)
      world.set(key(pos), block('stone', pos))
    }
  }

  const bot = {
    version: '1.20.4',
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    game: { gameMode: 'survival', dimension: 'minecraft:overworld' },
    inventory: {
      items: () => inventory.map((item) => ({ ...item })),
      firstEmptyInventorySlot: () => 10 + inventory.length,
    },
    blockAt(pos) {
      return world.get(key(pos)) ?? block('air', pos)
    },
    waitForChunksToLoad: async () => {},
    lookAt: async () => {},
    equip: async (item) => {
      currentItem = item
    },
    placeBlock: async (ref, face) => {
      const target = ref.position.plus(face)
      if (!currentItem) throw new Error('fake bot has no item equipped')
      world.set(key(target), block(currentItem.name, target))
    },
    dig: async (target) => {
      world.delete(key(target.position ?? target))
    },
    creative: {
      async setInventorySlot(_slot, item) {
        inventory.push({ name: item.name, type: item.type, count: item.count })
      },
    },
    pathfinder: {
      async goto() {},
      stop() {},
      isMoving: () => false,
    },
  }

  for (const [name, count] of Object.entries(gear)) {
    inventory.push({ name, type: 1, count })
  }

  return {
    bot,
    world,
    inventory,
    getBlock(x, y, z) {
      return world.get(`${x},${y},${z}`) ?? null
    },
    setBlock(x, y, z, name) {
      world.set(`${x},${y},${z}`, block(name, new Vec3(x, y, z)))
    },
    equipped: () => currentItem,
  }
}
