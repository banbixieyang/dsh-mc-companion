/**
 * In-game chat inbox.
 *
 * Two rules shape this module:
 *
 *   1. the companion talks to *everyone*, not just its owner — other players are
 *      part of the server's social life;
 *   2. in-game chat is **not** a control channel. Players can ask for anything;
 *      only the DSH user can command the bot. So messages are remembered,
 *      labelled (addressed to the bot? does it read like an order?) and shown to
 *      the model as untrusted social input — never executed by the plugin.
 *
 * The inbox is intentionally dumb: no replies, no side effects. The model
 * decides what to say on its next turn and calls `mc_chat`.
 */

/** Imperative / admin-looking messages, used only for labelling — never to obey. */
const COMMAND_LIKE = /^(?:[\/!]|来|去|挖|砍|打|杀|跟随|跟着|跟上|停下|停|别动|别跑|给我|帮我|替我|建|造|放|拆|破坏|回家|tp|give|kill|setblock|fill|gamemode|op|stop|follow|come|mine|dig|build|grief)/i

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Strip a leading "@Name" / "Name:" vocative so "DeepSeek 帮我挖矿" is still
 * recognised as an order. The label never changes what the plugin does.
 */
function stripVocative(text, botName) {
  if (!botName) return text
  const pattern = new RegExp(`^\\s*@?${escapeRegExp(botName)}\\s*[,，:：]?\\s*`, 'i')
  return text.replace(pattern, '')
}

export class ChatInbox {
  /**
   * @param {{ limit?: number, pendingTtlMs?: number, maxPending?: number, includeAllPlayers?: boolean }} [options]
   */
  constructor({ limit = 50, pendingTtlMs = 300_000, maxPending = 8, includeAllPlayers = true } = {}) {
    this.limit = Math.max(10, Number(limit) || 50)
    this.pendingTtlMs = Math.max(10_000, Number(pendingTtlMs) || 300_000)
    this.maxPending = Math.max(1, Math.min(20, Number(maxPending) || 8))
    this.includeAllPlayers = includeAllPlayers !== false
    /** @type {Array<{ id: string, username: string, message: string, at: number, addressed: boolean, commandLike: boolean, replied: boolean, owner: boolean }>} */
    this.items = []
    this.seq = 0
  }

  get size() {
    return this.items.length
  }

  /**
   * Record one public chat line. Returns the entry, or null when it is filtered
   * out (own messages, or non-owner messages while `includeAllPlayers` is off).
   */
  ingest({ username = '', message = '', at = Date.now(), owner = null, botName = '' } = {}) {
    const name = String(username ?? '').trim()
    const text = String(message ?? '').replace(/\s+/g, ' ').trim()
    if (!name || !text) return null
    if (botName && name.toLowerCase() === String(botName).toLowerCase()) return null
    const isOwner = Boolean(owner) && name.toLowerCase() === String(owner).toLowerCase()
    if (!this.includeAllPlayers && !isOwner) return null

    const lower = text.toLowerCase()
    const entry = {
      id: `chat-${Date.now().toString(36)}-${this.seq++}`,
      username: name,
      message: text.slice(0, 200),
      at,
      owner: isOwner,
      // "addressed" = the bot's name appears in the line, which is a hint that a
      // reply is expected. It is still not an order.
      addressed: Boolean(botName) && lower.includes(String(botName).toLowerCase()),
      commandLike: COMMAND_LIKE.test(stripVocative(text, botName).trim()),
      replied: false,
    }
    this.items.push(entry)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
    return entry
  }

  /** Unanswered lines inside the TTL, newest last, capped. */
  pending(now = Date.now()) {
    return this.items
      .filter((entry) => !entry.replied && now - entry.at <= this.pendingTtlMs)
      .slice(-this.maxPending)
  }

  /** Mark specific entries as answered. */
  markReplied(ids = []) {
    const set = new Set(ids)
    let changed = 0
    for (const entry of this.items) {
      if (!entry.replied && set.has(entry.id)) {
        entry.replied = true
        changed += 1
      }
    }
    return changed
  }

  /**
   * Treat everything currently pending as answered. Used after `mc_chat`: a
   * public line from the bot is a reply to the room, not to one person.
   */
  markAllReplied(now = Date.now()) {
    return this.markReplied(this.pending(now).map((entry) => entry.id))
  }

  clear() {
    this.items = []
  }

  snapshot(now = Date.now()) {
    const pending = this.pending(now)
    return {
      total: this.items.length,
      pending: pending.map(({ id, username, message, at, addressed, commandLike, owner }) => ({
        id,
        username,
        message,
        ageMs: now - at,
        addressed,
        commandLike,
        owner,
      })),
      last: this.items.slice(-3).map(({ username, message, at }) => ({ username, message, at })),
    }
  }
}
