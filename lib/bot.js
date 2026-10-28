/**
 * Headless Mineflayer bot lifecycle.
 *
 * This module is deliberately inert at import time: Mineflayer and
 * mineflayer-pathfinder are imported *inside* `connect()`, so loading the DSH
 * plugin (or simply reading this file) never starts a bot, opens a socket or
 * even loads the Minecraft protocol stack.
 *
 * The companion is passive by design:
 *   - no combat plugin, no auto-eat, no auto-pickup, no mining;
 *   - pathfinding is configured with `canDig = false` so following never
 *     breaks blocks;
 *   - blocks are only placed by an explicit build task from `lib/builder.js`.
 */

import { createRequire } from 'node:module'

/** Small helper: resolve a CJS module's exports for ESM dynamic import. */
function cjs(mod) {
  return mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod
}

/** CJS resolver rooted at this package (used for capability probes only). */
const requireHere = createRequire(import.meta.url)
function wait(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

function round2(value) {
  return Math.round(value * 100) / 100
}

const MOVEMENT_PACKETS = new Set(['position', 'position_look', 'look', 'flying'])

/** Parse "26.1" / "1.21.11" / "1.21.2-pre1" into comparable numbers. */
export function parseMcVersion(version) {
  const clean = String(version ?? '').trim().replace(/^v/i, '').split(/[-+]/)[0]
  const parts = clean.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length === 0 || parts.some((part) => Number.isNaN(part))) return null
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** True when `version` >= `minimum` (both Minecraft version strings). */
export function versionAtLeast(version, minimum) {
  const a = parseMcVersion(version)
  const b = parseMcVersion(minimum)
  if (!a || !b) return false
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return true
}

/**
 * Vanilla clients send `tick_end` after every physics tick since 1.21.2.
 * 26.3 servers require it (they kick bots that send two position packets in
 * one tick without it), so the compatibility shim is enabled from 1.21.2 up.
 */
export function supportsTickEnd(version) {
  return versionAtLeast(version, '1.21.2')
}

/**
 * `minecraft-protocol.supportedVersions` is a plain array (older shapes used an
 * object); keep only real version strings and pick the highest one.
 */
export function normalizeSupportedVersions(value) {
  const list = Array.isArray(value) ? value : Object.values(value ?? {})
  return list.filter((version) => typeof version === 'string' && /^\d+\.\d+/.test(version))
}

/** Highest supported Minecraft version, or null for an unknown list. */
export function latestSupportedVersion(value) {
  const versions = normalizeSupportedVersions(value)
  return versions.reduce((latest, version) => (!latest || versionAtLeast(version, latest) ? version : latest), null)
}

/** True for protocol/version negotiation failures (not network failures). */
export function isProtocolVersionError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /MC_VERSION_UNSUPPORTED|unsupported (client )?version|protocol version|unknown version|unsupported protocol/i.test(message)
}

async function newestSupportedClientVersion() {
  try {
    const protocol = cjs(await import('minecraft-protocol'))
    return latestSupportedVersion(protocol?.supportedVersions)
  } catch {
    return null
  }
}

const VERSION_HINT_26_3 =
  '26.3（协议 777）需要仓库自带的兼容层：运行 "node scripts/install-263-compat.mjs"（npm postinstall 会执行），' +
  '它把 vendor/mc-data-26.3 的数据装进 minecraft-data，并补上 minecraft-protocol / mineflayer / prismarine-chunk 的版本登记、' +
  'tick_end 与 entityDelta 支持。若未安装，可临时把 version 设为 "26.1" 并让服务器装 ViaVersion + ViaBackwards。'

/** @typedef {import('./events.js').EventLog} EventLog */

export class BotController {
  /**
   * @param {{ config: Record<string, any>, events: EventLog }} options
   */
  constructor({ config, events }) {
    this.config = config
    this.events = events
    /** @type {any} */
    this.bot = null
    /** @type {any} */
    this.mineflayer = null
    /** @type {any} */
    this.pathfinder = null
    this.mineflayerLoaded = false
    this.online = false
    this.connecting = null
    this.startedAt = 0
    this.lastError = null
    this.connection = null
    this.follow = null
    this.timers = new Set()
    this.listeners = []
    this.lastHealth = null
    this.lastFood = null
    this.lastDimension = null
    this.lastPosition = null
    this.ownerChatCount = 0
    this.tickEndPatched = false
    this.nativeTickEnd = false
    this.nativeTickEndProbe = undefined
    /** @type {((name: string, packet: unknown) => unknown) | null} */
    this.originalClientWrite = null
    this.usedVersionFallback = null
  }

  /** Add a tracked interval; disabling the mode clears all of them. */
  #interval(fn, ms) {
    const timer = setInterval(fn, ms)
    if (typeof timer.unref === 'function') timer.unref()
    this.timers.add(timer)
    return timer
  }

  #clearTimers() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers.clear()
  }

  #listen(bot, event, handler) {
    bot.on(event, handler)
    this.listeners.push([event, handler])
  }

  #unlisten(bot) {
    for (const [event, handler] of this.listeners) {
      try {
        bot.removeListener(event, handler)
      } catch {
        /* bot may already be torn down */
      }
    }
    this.listeners = []
  }

  /** Connection summary plus a live entity snapshot. */
  snapshot() {
    const bot = this.bot
    const connected = Boolean(bot) && !bot._client?.ended
    const online = this.online && Boolean(bot?.entity)
    const entity = bot?.entity
    const position = entity?.position ?? this.lastPosition
    return {
      connected,
      online,
      username: this.connection?.username ?? this.config.username,
      host: this.connection?.host ?? this.config.host,
      port: this.connection?.port ?? this.config.port,
      version: bot?.version ?? null,
      health: typeof bot?.health === 'number' ? bot.health : null,
      food: typeof bot?.food === 'number' ? bot.food : null,
      dimension: bot?.game?.dimension ?? null,
      position: position
        ? { x: round2(position.x), y: round2(position.y), z: round2(position.z) }
        : null,
      ping: bot?.player?.ping ?? null,
      players: bot ? Object.keys(bot.players ?? {}) : [],
      gameMode: bot?.game?.gameMode ?? null,
      follow: this.follow ? { ...this.follow } : null,
      uptimeMs: this.online && this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      lastError: this.lastError,
      tickEndCompat: this.tickEndPatched || this.nativeTickEnd,
      versionFallback: this.usedVersionFallback,
    }
  }

  /**
   * Create and connect a bot. Resolves once the bot spawned, rejects on a
   * connect error, kick, or timeout.
   *
   * @param {{ host?: string, port?: number, username?: string, version?: string, timeoutMs?: number }} [options]
   */
  async connect(options = {}) {
    if (this.connecting) return this.connecting
    if (this.bot && this.online) {
      return { alreadyConnected: true, ...this.snapshot() }
    }
    this.usedVersionFallback = null
    this.connecting = (async () => {
      try {
        return await this.#connect(options)
      } catch (error) {
        const explicitVersion = options.version ?? this.config.version
        if (explicitVersion || this.config.autoVersionFallback === false || !isProtocolVersionError(error)) {
          throw error
        }
        // A 26.3 server behind ViaBackwards advertises protocol 777, which this
        // client stack does not know. Retry once as the newest supported client
        // (26.1); Via translates it. Without Via the retry fails and is reported.
        const fallback = await newestSupportedClientVersion()
        if (!fallback) throw error
        this.events.push('compat', `服务器协议不受支持，自动回退到客户端 ${fallback} 重试（需要服务端 ViaBackwards）`)
        try {
          const result = await this.#connect({ ...options, version: fallback })
          this.usedVersionFallback = fallback
          return { ...result, versionFallback: fallback }
        } catch (retryError) {
          this.events.push(
            'compat',
            `回退 ${fallback} 仍失败：${retryError instanceof Error ? retryError.message : String(retryError)}`,
          )
          throw retryError
        }
      }
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  async #connect(options) {
    const host = options.host ?? this.config.host
    const port = Number(options.port ?? this.config.port) || this.config.port
    const username = options.username ?? this.config.username
    const version = options.version ?? this.config.version ?? undefined
    const timeoutMs = Number(options.timeoutMs ?? this.config.connectTimeoutMs) || 20_000

    if (!host || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`MC_CONNECT_INVALID_TARGET: host=${String(host)} port=${String(port)}`)
    }
    if (!username || !/^[A-Za-z0-9_]{1,16}$/.test(username)) {
      throw new Error(`MC_CONNECT_INVALID_USERNAME: offline usernames must match [A-Za-z0-9_]{1,16}, got "${username}"`)
    }

    // A previous bot may have ended without being disposed (server stop,
    // network loss). Release its listeners before creating a new one.
    if (this.bot) {
      const stale = this.bot
      this.bot = null
      this.#clearTimers()
      this.#unlisten(stale)
      this.#restoreClientWrite(stale)
      try {
        stale.removeAllListeners()
        stale.quit('reconnect')
      } catch {
        /* ignore */
      }
    }

    this.events.push('connect', `正在以离线账号 ${username} 连接 ${host}:${port}${version ? `（${version}）` : ''}`)
    await this.#assertVersionSupported(version)

    let mineflayer
    let pathfinderModule
    try {
      mineflayer = cjs(await import('mineflayer'))
      this.mineflayerLoaded = true
      pathfinderModule = cjs(await import('mineflayer-pathfinder'))
    } catch (error) {
      throw new Error(
        `MC_DEPENDENCY_MISSING: 无法加载 mineflayer / mineflayer-pathfinder（${error instanceof Error ? error.message : String(error)}）。请在插件目录运行 npm install。`,
      )
    }

    let bot
    try {
      bot = mineflayer.createBot({
        host,
        port,
        username,
        auth: 'offline',
        ...(version ? { version } : {}),
        // Keep the bot inside the DSH process; never spawn a game window.
        hideErrors: true,
      })
    } catch (error) {
      throw this.#mapVersionError(error)
    }
    this.bot = bot
    this.connection = { host, port, username }
    this.lastError = null

    try {
      bot.loadPlugin(pathfinderModule.pathfinder)
      this.pathfinder = {
        pathfinder: pathfinderModule.pathfinder,
        Movements: pathfinderModule.Movements,
        goals: pathfinderModule.goals,
      }
    } catch (error) {
      // Pathfinding is required for following; fail loudly instead of silently
      // degrading into a bot that cannot keep up with the player.
      await this.#abort(bot, `MC_PATHFINDER_SETUP_FAILED: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }

    this.#installListeners(bot)

    try {
      await this.#waitForSpawn(bot, timeoutMs)
    } catch (error) {
      const mapped = this.#mapVersionError(error)
      await this.#abort(bot, mapped.message)
      throw mapped
    }

    this.online = true
    this.startedAt = Date.now()
    this.lastHealth = bot.health
    this.lastFood = bot.food
    this.lastDimension = bot.game?.dimension ?? null
    this.lastPosition = bot.entity?.position?.clone?.() ?? bot.entity?.position ?? null
    this.#installTickEndCompat(bot)
    this.events.push('spawn', `已作为 ${username} 上线（${bot.version ?? version ?? 'auto'}）`, {
      position: bot.entity?.position ? {
        x: round2(bot.entity.position.x),
        y: round2(bot.entity.position.y),
        z: round2(bot.entity.position.z),
      } : null,
      dimension: bot.game?.dimension ?? null,
    })

    this.#configurePathfinder()
    this.#startSampler()

    // Opt-in auto-follow: only for the configured owner, and never awaited so
    // a slow entity packet cannot delay the connect result.
    if (this.config.autoFollow && this.config.owner) {
      this.followPlayer(this.config.owner, this.config.followRadius).catch((error) => {
        this.events.push('follow', `自动跟随失败：${error instanceof Error ? error.message : String(error)}`)
      })
    }

    return this.snapshot()
  }

  async #abort(bot, message) {
    this.lastError = message
    this.events.push('connect_error', message)
    this.#restoreClientWrite(bot)
    try {
      bot.quit('connect failed')
    } catch {
      /* ignore */
    }
    await wait(150)
    try {
      bot.removeAllListeners()
    } catch {
      /* ignore */
    }
    if (this.bot === bot) this.bot = null
    this.online = false
    this.follow = null
    this.#clearTimers()
  }

  /**
   * Reject a protocol version the installed client stack cannot speak, with a
   * 26.3-specific explanation instead of an opaque socket error.
   */  async #assertVersionSupported(version) {
    if (!version) return
    let protocol
    try {
      protocol = cjs(await import('minecraft-protocol'))
    } catch {
      return
    }
    const supported = normalizeSupportedVersions(protocol?.supportedVersions)
    if (supported.length === 0 || supported.includes(version)) return
    const latest = latestSupportedVersion(supported)
    const hint = version.startsWith('26.') && versionAtLeast(version, '26.3')
      ? VERSION_HINT_26_3
      : `当前协议栈支持的最近版本：${supported.slice(-6).join(', ')}。`
    throw new Error(`MC_VERSION_UNSUPPORTED: 不支持客户端版本 ${version}（最高 ${latest}）。${hint}`)
  }

  /** Turn protocol/version errors into MC_VERSION_UNSUPPORTED with a hint. */
  #mapVersionError(error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/unsupported (client )?version|unknown version|protocol version|unsupported protocol/i.test(message)) {
      return new Error(`MC_VERSION_UNSUPPORTED: ${message}。${VERSION_HINT_26_3}`)
    }
    return error instanceof Error ? error : new Error(message)
  }

  /**
   * Work around the 26.3 "invalid_player_movement" kick by sending the
   * serverbound tick_end packet after movement writes, exactly like a vanilla
   * client does since 1.21.2. This also helps on 26.3 servers behind
   * ViaBackwards where the bot speaks 26.1.
   *
   * If the installed mineflayer acknowledges ticks itself (scripts/
   * install-263-compat.mjs patches its physics loop), the shim is skipped —
   * two tick_end packets per movement would be worse than none.
   */
  #installTickEndCompat(bot) {
    const mode = this.config.tickEndCompat
    if (mode === 'off' || !bot?._client || typeof bot._client.write !== 'function') return
    if (mode !== 'always' && !supportsTickEnd(bot.version)) return
    if (this.tickEndPatched) return
    if (this.#mineflayerSendsTickEnd()) {
      this.nativeTickEnd = true
      this.events.push('compat', `mineflayer 已内建 tick_end（客户端 ${bot.version}），无需插件补丁`)
      return
    }
    const original = bot._client.write.bind(bot._client)
    this.originalClientWrite = original
    bot._client.write = (name, packet) => {
      const result = original(name, packet)
      if (MOVEMENT_PACKETS.has(name)) {
        try {
          original('tick_end', {})
        } catch {
          /* protocol without tick_end */
        }
      }
      return result
    }
    this.tickEndPatched = true
    this.events.push('compat', `已启用 tick_end 兼容（客户端 ${bot.version}）`)
  }

  /** True when the installed mineflayer declares that it acks ticks itself. */
  #mineflayerSendsTickEnd() {
    if (this.nativeTickEndProbe === undefined) {
      try {
        this.nativeTickEndProbe = requireHere('mineflayer/lib/version')?.sendsClientTickEnd === true
      } catch {
        this.nativeTickEndProbe = false
      }
    }
    return this.nativeTickEndProbe
  }

  #restoreClientWrite(bot) {
    if (!this.tickEndPatched) return
    try {
      if (bot?._client && this.originalClientWrite) bot._client.write = this.originalClientWrite
    } catch {
      /* ignore */
    }
    this.tickEndPatched = false
    this.originalClientWrite = null
  }

  #waitForSpawn(bot, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('kicked', onKick)
        bot.removeListener('end', onEnd)
        bot.removeListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        finish(new Error(`MC_CONNECT_TIMEOUT: 在 ${timeoutMs}ms 内没有等到 spawn（服务器可达？online-mode=false？）`))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      const onSpawn = () => finish()
      const onKick = (reason, loggedIn) => {
        const text = typeof reason === 'string' ? reason : JSON.stringify(reason ?? {})
        finish(new Error(`MC_CONNECT_KICKED: ${text}${loggedIn ? '' : '（未完成登录）'}`))
      }
      const onEnd = (reason) => finish(new Error(`MC_CONNECT_ENDED: ${reason ?? 'connection closed'}`))
      const onError = (error) => finish(new Error(`MC_CONNECT_ERROR: ${error?.message ?? String(error)}`))
      bot.once('spawn', onSpawn)
      bot.once('kicked', onKick)
      bot.once('end', onEnd)
      bot.once('error', onError)
    })
  }

  #installListeners(bot) {
    this.#listen(bot, 'login', () => {
      this.events.push('login', '登录握手完成')
    })

    this.#listen(bot, 'spawn', () => {
      this.online = true
      this.events.push('spawn', '角色已生成')
    })

    this.#listen(bot, 'chat', (username, message) => {
      if (!username || username === bot.username) return
      const isOwner = this.config.owner ? username === this.config.owner : false
      if (isOwner) this.ownerChatCount += 1
      this.events.push('chat', `${username}: ${message}`, { username, message, owner: isOwner })
      // Social input only: the inbox labels it, nothing acts on it here.
      this.onChat?.(username, message, { owner: isOwner })
    })

    this.#listen(bot, 'whisper', (username, message) => {
      if (!username || username === bot.username) return
      this.events.push('whisper', `${username} 私聊: ${message}`, { username, message })
    })

    this.#listen(bot, 'health', () => {
      const health = bot.health
      const food = bot.food
      if (typeof health !== 'number') return
      if (this.lastHealth === null || Math.abs(health - this.lastHealth) >= 1) {
        this.events.push('health', `生命值 ${health}/20，饥饿值 ${food}/20`, { health, food })
      }
      this.lastHealth = health
      this.lastFood = food
    })

    this.#listen(bot, 'death', () => {
      this.events.push('death', 'Bot 死亡了', this.#positionData(bot))
      this.lastPosition = bot.entity?.position?.clone?.() ?? bot.entity?.position ?? this.lastPosition
      // Being dead is not a reason to stop being a companion; Mineflayer
      // respawns automatically. This only records the event.
    })

    this.#listen(bot, 'respawn', () => {
      this.events.push('respawn', '已重生')
      if (this.follow && bot.entity) this.applyFollowGoal()
    })

    this.#listen(bot, 'kicked', (reason, loggedIn) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason ?? {})
      this.events.push('kicked', `被服务器踢出：${text}${loggedIn ? '' : '（未完成登录）'}`, { reason: text, loggedIn })
      this.online = false
    })

    this.#listen(bot, 'error', (error) => {
      this.lastError = error?.message ?? String(error)
      this.events.push('error', `Bot 错误：${this.lastError}`)
    })

    this.#listen(bot, 'end', (reason) => {
      this.online = false
      this.follow = null
      this.#clearTimers()
      this.events.push('disconnect', `与服务器断开：${reason ?? 'unknown'}`)
    })
  }

  #configurePathfinder() {
    const bot = this.bot
    if (!bot?.pathfinder || !this.pathfinder) return
    const { Movements } = this.pathfinder
    try {
      const movements = new Movements(bot)
      // Companion rules: following must never dig, pillar up, or fight.
      movements.canDig = false
      movements.allow1by1towers = false
      movements.scafoldingBlocks = []
      movements.maxDropDown = 3
      movements.canOpenDoors = false
      bot.pathfinder.setMovements(movements)
      bot.pathfinder.thinkTimeout = 5_000
      bot.pathfinder.tickTimeout = 40
    } catch (error) {
      this.events.push('error', `寻路配置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #startSampler() {
    this.#interval(() => {
      const bot = this.bot
      if (!bot?.entity) return
      this.lastPosition = bot.entity.position?.clone?.() ?? bot.entity.position
      const dimension = bot.game?.dimension
      if (dimension && dimension !== this.lastDimension) {
        this.lastDimension = dimension
        this.events.push('dimension', `进入维度 ${dimension}`)
      }
      // Keep a live follow goal: if the player moved away and pathfinding
      // stopped (e.g. after a respawn or a failed path), re-issue it.
      if (this.follow && !bot.pathfinder?.isMoving?.()) {
        const entity = bot.players?.[this.follow.player]?.entity
        if (entity && bot.entity.position.distanceTo(entity.position) > this.follow.radius + 2) {
          this.applyFollowGoal()
        }
      }
    }, 2_000)
  }

  #positionData(bot) {
    const position = bot?.entity?.position
    return position
      ? { x: round2(position.x), y: round2(position.y), z: round2(position.z) }
      : null
  }

  /** Start following a player. Returns the resolved follow state. */
  async followPlayer(playerName, radius) {
    const bot = this.bot
    if (!bot || !this.online || !bot.entity) {
      throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线，先调用 mc_bot_connect。')
    }
    if (!bot.pathfinder || !this.pathfinder) {
      throw new Error('MC_PATHFINDER_MISSING: mineflayer-pathfinder 未加载。')
    }
    const name = String(playerName ?? this.config.owner ?? '').trim()
    if (!name) {
      throw new Error('MC_FOLLOW_NO_TARGET: 需要 player 名称，或在配置里设置 owner。')
    }
    // The player list entry can arrive a tick before the entity does (right
    // after join or after a teleport); wait briefly instead of failing.
    const deadline = Date.now() + 3_000
    let player = bot.players?.[name]
    while ((!player || !player.entity) && Date.now() < deadline) {
      await wait(200)
      player = bot.players?.[name]
    }
    if (!player) {
      throw new Error(`MC_PLAYER_NOT_FOUND: 服务器里没有玩家 "${name}"（在线：${Object.keys(bot.players ?? {}).join(', ') || '无'}）`)
    }
    if (!player.entity) {
      throw new Error(`MC_PLAYER_NOT_VISIBLE: 能看到玩家 "${name}" 但还没有实体（距离太远？）`)
    }
    if (!this.online || this.bot !== bot) {
      throw new Error('MC_BOT_NOT_CONNECTED: Bot 在切换玩家时已断开。')
    }
    const distance = Math.min(10, Math.max(1, Number(radius) || this.config.followRadius))
    this.follow = { player: name, radius: distance }
    this.applyFollowGoal()
    this.events.push('follow', `开始跟随 ${name}（半径 ${distance} 格）`, { player: name, radius: distance })
    return { ...this.follow }
  }

  /** Re-issue the GoalFollow for the current target. */
  applyFollowGoal() {
    const bot = this.bot
    if (!bot?.pathfinder || !this.follow) return false
    const entity = bot.players?.[this.follow.player]?.entity
    if (!entity) return false
    const { goals } = this.pathfinder
    try {
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, this.follow.radius), true)
      return true
    } catch (error) {
      this.events.push('error', `跟随失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** Stop following; the bot stays online and still responds to chat. */
  stopFollow() {
    this.follow = null
    try {
      this.bot?.pathfinder?.setGoal?.(null)
    } catch {
      /* ignore */
    }
    this.events.push('follow', '停止跟随')
  }

  /** Send one public chat message. */
  chat(message) {
    const bot = this.bot
    if (!bot || !this.online) throw new Error('MC_BOT_NOT_CONNECTED: Bot 尚未上线。')
    const text = String(message ?? '').replace(/[\r\n]+/g, ' ').trim()
    if (!text) throw new Error('MC_CHAT_EMPTY: 消息不能为空。')
    if (text.length > 256) throw new Error('MC_CHAT_TOO_LONG: 一条聊天最多 256 个字符（含命令前缀）。')
    bot.chat(text)
    this.events.push('chat_out', `Bot: ${text}`, { message: text })
    return { message: text, length: text.length }
  }

  /** Disconnect and release every timer/listener owned by the bot. */
  async disconnect(reason = 'manual') {
    const bot = this.bot
    this.follow = null
    this.#clearTimers()
    this.online = false
    if (!bot) {
      this.connection = null
      return { disconnected: false, alreadyOffline: true }
    }
    this.bot = null
    this.#restoreClientWrite(bot)
    try {
      bot.pathfinder?.stop?.()
    } catch {
      /* ignore */
    }
    const ended = new Promise((resolve) => {
      const timer = setTimeout(resolve, 3_000)
      if (typeof timer.unref === 'function') timer.unref()
      bot.once('end', () => {
        clearTimeout(timer)
        resolve()
      })
      bot.once('error', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    try {
      bot.quit(reason)
    } catch {
      /* ignore */
    }
    await ended
    this.#unlisten(bot)
    try {
      bot.removeAllListeners()
    } catch {
      /* ignore */
    }
    this.connection = null
    this.startedAt = 0
    this.events.push('disconnect', `Bot 已断开：${reason}`)
    return { disconnected: true }
  }

  /** Release everything without emitting a normal disconnect event. */
  async dispose() {
    this.#clearTimers()
    const bot = this.bot
    this.bot = null
    this.follow = null
    this.online = false
    if (!bot) return
    this.#restoreClientWrite(bot)
    try {
      bot.pathfinder?.stop?.()
    } catch {
      /* ignore */
    }
    try {
      bot.quit('plugin unload')
    } catch {
      /* ignore */
    }
    this.#unlisten(bot)
    try {
      bot.removeAllListeners()
    } catch {
      /* ignore */
    }
    this.connection = null
    this.startedAt = 0
  }
}
