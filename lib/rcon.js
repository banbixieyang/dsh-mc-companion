/**
 * RCON client for driving the server-side companion mod.
 *
 * The mod (`dsh-mc-companion-server`) executes real operations on the server and
 * exposes them as `/dshmc ...` commands. Talking to it over RCON means our bot
 * actions are performed by the server itself — no protocol emulation.
 */
import net from 'node:net'

const SERVERDATA_AUTH = 3
const SERVERDATA_AUTH_RESPONSE = 2
const SERVERDATA_EXECCOMMAND = 2
const SERVERDATA_RESPONSE_VALUE = 0

function packet (id, type, body) {
  const payload = Buffer.from(body, 'utf8')
  const buffer = Buffer.alloc(14 + payload.length)
  buffer.writeInt32LE(buffer.length - 4, 0)
  buffer.writeInt32LE(id, 4)
  buffer.writeInt32LE(type, 8)
  payload.copy(buffer, 12)
  buffer.write('\0', 12 + payload.length, 'utf8')
  buffer.write('\0', 13 + payload.length, 'utf8')
  return buffer
}

export class RconClient {
  constructor ({ host = '127.0.0.1', port = 25575, password = '', timeoutMs = 8_000 } = {}) {
    this.host = host
    this.port = port
    this.password = password
    this.timeoutMs = timeoutMs
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.nextId = 1
    this.ready = false
  }

  async connect () {
    if (this.ready) return this
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`RCON connect timeout (${this.host}:${this.port})`))
      }, this.timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`RCON connect failed: ${error.message}`))
      })
    })
    this.socket.on('data', (chunk) => this.#onData(chunk))
    this.socket.on('error', () => this.#failAll(new Error('RCON socket error')))
    this.socket.on('close', () => this.#failAll(new Error('RCON closed')))
    await this.#auth()
    this.ready = true
    return this
  }

  async #auth () {
    const id = this.nextId++
    const promise = this.#wait(id)
    this.socket.write(packet(id, SERVERDATA_AUTH, this.password))
    const result = await promise
    if (result.id === -1) throw new Error('RCON auth failed: wrong password')
  }

  #wait (id) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('RCON command timeout'))
      }, this.timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  #failAll (error) {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
    this.ready = false
  }

  #onData (chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 12) {
      const size = this.buffer.readInt32LE(0)
      if (this.buffer.length < size + 4) break
      const id = this.buffer.readInt32LE(4)
      const type = this.buffer.readInt32LE(8)
      const body = this.buffer.subarray(12, size + 2).toString('utf8')
      this.buffer = this.buffer.subarray(size + 4)
      // The auth reply has type 2 with the same id; exec replies are type 0.
      const entry = this.pending.get(id) ?? this.pending.get(id === -1 ? this.nextId - 1 : id)
      if (!entry) continue
      if (type === SERVERDATA_AUTH_RESPONSE) {
        this.pending.delete(id)
        entry.resolve({ id, body })
        continue
      }
      if (type === SERVERDATA_RESPONSE_VALUE) {
        this.pending.delete(id)
        entry.resolve({ id, body: body.replace(/\0+$/, '') })
      }
    }
  }

  async command (command) {
    await this.connect()
    const id = this.nextId++
    const promise = this.#wait(id)
    this.socket.write(packet(id, SERVERDATA_EXECCOMMAND, command))
    const result = await promise
    return result.body.replace(/\0+$/, '').trim()
  }

  close () {
    this.ready = false
    try {
      this.socket?.end()
    } catch {
      /* ignore */
    }
    this.socket = null
  }
}
