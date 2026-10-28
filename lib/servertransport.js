/**
 * Transport that drives the server-side companion mod over RCON.
 *
 * The mod executes every operation with the server's own world objects, so the
 * actions here are authoritative: `/dshmc dig` really breaks a block, and the
 * reply tells us what happened. This is the "real operations" path that replaces
 * client-side protocol emulation for Minecraft versions without a supported
 * mineflayer (26.3 and newer).
 */
import { RconClient } from './rcon.js'

const strip = (text) => text.replace(/^dshmc:\s*/i, '').trim()

export class ServerTransport {
  constructor ({ config, events, client = null }) {
    this.config = config
    this.events = events
    this.client = client ?? new RconClient({
      host: config?.server?.host ?? '127.0.0.1',
      port: config?.server?.port ?? 25575,
      password: config?.server?.password ?? ''
    })
    this.botName = config?.server?.botName ?? 'Bot'
  }

  async #run (command) {
    const reply = await this.client.command(command)
    if (!reply) return { ok: true, reply: '' }
    if (/^dshmc:/i.test(reply) && /not found|refused|missing|unknown|nothing|already|no recipe/i.test(reply)) {
      return { ok: false, reply: strip(reply) }
    }
    return { ok: true, reply: strip(reply) }
  }

  async connect () {
    await this.client.connect()
    return { ok: true, host: this.config?.server?.host, port: this.config?.server?.port }
  }

  /** Spawn (or revive) the fake player through Carpet. */
  async spawn (name = this.botName) {
    const reply = await this.client.command(`player ${name} spawn`)
    this.events?.push?.('server', `假玩家 ${name} 已生成（${reply || 'ok'}）`)
    return { ok: true, reply }
  }

  /** Stop the fake player. */
  async despawn (name = this.botName) {
    const reply = await this.client.command(`player ${name} kill`)
    return { ok: true, reply }
  }

  async gamemode (mode, name = this.botName) {
    return await this.#run(`gamemode ${mode} ${name}`)
  }

  async give (item, count = 1, name = this.botName) {
    return await this.#run(`give ${name} ${item} ${count}`)
  }

  async clear (name = this.botName) {
    return await this.#run(`clear ${name}`)
  }

  async walk (x, y, z, name = this.botName) {
    return await this.#run(`dshmc walk ${name} ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`)
  }

  async dig (x, y, z, name = this.botName) {
    return await this.#run(`dshmc dig ${name} ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`)
  }

  async place (x, y, z, block, name = this.botName) {
    return await this.#run(`dshmc place ${name} ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${block}`)
  }

  async look (x, y, z, name = this.botName) {
    return await this.#run(`dshmc look ${name} ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)}`)
  }

  async inventory (name = this.botName) {
    const result = await this.#run(`dshmc inv ${name}`)
    return { ...result, ...parseInventory(result.reply) }
  }

  async count (item, name = this.botName) {
    const result = await this.#run(`dshmc count ${name} ${item}`)
    const match = /= (\d+)/.exec(result.reply ?? '')
    return { ...result, count: match ? Number(match[1]) : 0 }
  }

  async state (name = this.botName) {
    const result = await this.#run(`dshmc state ${name}`)
    return { ...result, ...parseState(result.reply) }
  }

  /** Raw escape hatch: run any server command. */
  async command (raw) {
    const reply = await this.client.command(raw)
    return { ok: true, reply: reply.trim() }
  }

  close () {
    this.client.close?.()
  }
}

/** 'inv Bot held=stone_pickaxe items=oak_planksx4,stickx2' -> { held, items } */
export function parseInventory (reply) {
  const text = String(reply ?? '')
  const held = /held=(\S+)/.exec(text)?.[1] ?? null
  const itemsPart = /items=(.*)$/.exec(text)?.[1] ?? ''
  const items = {}
  for (const entry of itemsPart.split(',')) {
    const match = /^(\S+)x(\d+)$/.exec(entry.trim())
    if (match) items[match[1]] = Number(match[2])
  }
  return { held, items }
}

/** 'state Bot pos=10,64,3 hp=20.0 food=18 mode=survival dim=...' -> object */
export function parseState (reply) {
  const text = String(reply ?? '')
  const pos = /pos=(-?\d+),(-?\d+),(-?\d+)/.exec(text)
  const hp = /hp=([\d.]+)/.exec(text)
  const food = /food=(\d+)/.exec(text)
  const mode = /mode=(\w+)/.exec(text)
  const dim = /dim=(\S+)/.exec(text)
  return {
    position: pos ? { x: Number(pos[1]), y: Number(pos[2]), z: Number(pos[3]) } : null,
    health: hp ? Number(hp[1]) : null,
    food: food ? Number(food[1]) : null,
    gameMode: mode ? mode[1] : null,
    dimension: dim ? dim[1] : null
  }
}
