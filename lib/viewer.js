/**
 * Live first-person view of the bot.
 *
 * prismarine-viewer renders the world the bot sees in a browser (three.js over a
 * websocket), which is the closest thing to "watching the bot's screen". The
 * viewer is started lazily when the bot comes online and is always optional: a
 * viewer failure (port taken, unsupported version assets) must never take the
 * bot down, so every failure is captured into `snapshot().error` and the event
 * log instead of throwing.
 *
 * prismarine-viewer's mineflayer entry returns nothing; it attaches
 * `bot.viewer.close()` and listens on the port in the background, so "running"
 * means "that handle exists and the port accepts connections".
 */
import net from 'node:net'

const DEFAULT_PORT = 3010

function waitForPort (port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) resolve(false)
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

export class ViewerHost {
  /**
   * @param {{ botController: any, config: Record<string, any>, events: any }} options
   */
  constructor ({ botController, config, events }) {
    this.botController = botController
    this.config = config
    this.events = events
    this.handle = null
    this.bot = null
    this.port = Number(config?.viewer?.port) || DEFAULT_PORT
    this.firstPerson = config?.viewer?.firstPerson !== false
    this.error = null
    this.startedAt = null
  }

  get enabled () {
    return this.config?.viewer?.enabled !== false
  }

  get running () {
    return Boolean(this.handle)
  }

  /** URL the panel button opens; null while the viewer is not running. */
  get url () {
    return this.running ? `http://127.0.0.1:${this.port}/` : null
  }

  /**
   * Start (or restart) the viewer for the current bot.
   * @param {any} bot raw mineflayer bot
   */
  async start (bot = this.botController?.bot) {
    if (!this.enabled) return this.snapshot()
    if (!bot || !bot.entity) return this.snapshot()
    if (this.handle && this.bot === bot) return this.snapshot()
    this.stop()
    this.bot = bot
    this.error = null
    try {
      // Lazy: the plugin must stay loadable without three.js/socket.io installed.
      const { createRequire } = await import('node:module')
      const require = createRequire(import.meta.url)
      const { mineflayer } = require('prismarine-viewer')
      mineflayer(bot, {
        port: this.port,
        firstPerson: this.firstPerson,
        viewDistance: Number(this.config?.viewer?.viewDistance) || 6
      })
      if (!bot.viewer || typeof bot.viewer.close !== 'function') {
        throw new Error('prismarine-viewer did not attach to the bot')
      }
      const listening = await waitForPort(this.port, 12_000)
      if (!listening) {
        try {
          bot.viewer.close()
        } catch {
          /* ignore */
        }
        throw new Error(`viewer port ${this.port} is not reachable`)
      }
      this.handle = bot.viewer
      this.startedAt = Date.now()
      this.events?.push?.('viewer', `视角已开启：${this.url}`, { port: this.port })
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.handle = null
      this.events?.push?.('error', `视角启动失败：${this.error}`, { port: this.port })
    }
    return this.snapshot()
  }

  stop () {
    const handle = this.handle
    this.handle = null
    this.startedAt = null
    if (!handle) {
      this.bot = null
      return this.snapshot()
    }
    try {
      handle.close()
    } catch {
      /* ignore */
    }
    try {
      if (this.bot?.viewer === handle) delete this.bot.viewer
    } catch {
      /* ignore */
    }
    this.bot = null
    return this.snapshot()
  }

  snapshot () {
    return {
      enabled: this.enabled,
      running: this.running,
      url: this.url,
      port: this.port,
      firstPerson: this.firstPerson,
      error: this.error,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0
    }
  }
}

export { DEFAULT_PORT as DEFAULT_VIEWER_PORT }
