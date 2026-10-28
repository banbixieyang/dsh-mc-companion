/**
 * Minimal Minecraft RCON client.
 *
 * The test harness needs to drive a server's console (teleport a player, change
 * a gamerule). Piping stdin to the child process is not possible in restricted
 * sandboxes — spawning with any pipe fails with EPERM — so console commands go
 * through RCON instead, which also works when the server was started by hand.
 *
 * Protocol: int32 length, int32 requestId, int32 type, payload, two null bytes.
 * type 3 = login, 2 = command, 0 = command response.
 */
import net from 'node:net'

/** Password used by the local, disposable test servers only. */
export const RCON_PASSWORD = 'dsh-mc-test'

const TYPES = { RESPONSE: 0, COMMAND: 2, LOGIN: 3 }

function encode (requestId, type, body) {
  const payload = Buffer.from(body, 'utf8')
  const buffer = Buffer.alloc(payload.length + 14)
  buffer.writeInt32LE(payload.length + 10, 0)
  buffer.writeInt32LE(requestId, 4)
  buffer.writeInt32LE(type, 8)
  payload.copy(buffer, 12)
  buffer.writeInt16LE(0, payload.length + 12)
  return buffer
}

/** Read exactly one RCON frame; resolves { requestId, type, body }. */
function readFrame (socket, buffered) {
  return new Promise((resolve, reject) => {
    const tryParse = (buffer) => {
      if (buffer.length < 4) return null
      const length = buffer.readInt32LE(0)
      if (buffer.length < length + 4) return null
      return {
        requestId: buffer.readInt32LE(4),
        type: buffer.readInt32LE(8),
        body: buffer.slice(12, length + 2).toString('utf8'),
        rest: buffer.slice(length + 4)
      }
    }

    const parsed = tryParse(buffered)
    if (parsed) return resolve(parsed)

    let chunks = buffered
    const onData = (chunk) => {
      chunks = Buffer.concat([chunks, chunk])
      const frame = tryParse(chunks)
      if (frame) {
        socket.off('data', onData)
        socket.off('error', onError)
        resolve(frame)
      }
    }
    const onError = (error) => {
      socket.off('data', onData)
      socket.off('error', onError)
      reject(error)
    }
    socket.on('data', onData)
    socket.on('error', onError)
  })
}

/**
 * Run one console command.
 * @param {{ host?: string, port: number, password: string, command: string, timeoutMs?: number }} options
 * @returns {Promise<string>} the server's textual response
 */
export function rconCommand ({ host = '127.0.0.1', port, password, command, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(timeoutMs)
    const fail = (error) => {
      socket.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    socket.once('timeout', () => fail(new Error(`RCON timeout after ${timeoutMs}ms (port ${port})`)))
    socket.once('error', fail)

    socket.once('connect', async () => {
      try {
        socket.write(encode(1, TYPES.LOGIN, password))
        const login = await readFrame(socket, Buffer.alloc(0))
        if (login.requestId === -1) return fail(new Error('RCON authentication failed (wrong rcon.password)'))
        socket.write(encode(2, TYPES.COMMAND, command))
        const response = await readFrame(socket, Buffer.alloc(0))
        socket.destroy()
        resolve(response.body)
      } catch (error) {
        fail(error)
      }
    })
  })
}

/** True when something is listening on the RCON port. */
export function rconPortOpen (port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
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

