/**
 * Small persistent memory for the companion.
 *
 * Deliberately not a vector store and not a chat log. A companion only needs a
 * handful of durable facts: where home is, what was built and where, which
 * behaviours the player corrected, and what went wrong last time. Those are
 * cheap to keep in one JSON file and cheap to inject as a couple of lines.
 *
 * The store is synchronous on purpose: `promptText()` is a synchronous hook and
 * must never await disk I/O in the middle of a model request.
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE_VERSION = 1
const DEFAULT_LIMIT = 200
/** Kinds we accept; anything else is coerced to `note`. */
export const MEMORY_KINDS = new Set(['place', 'build', 'correction', 'lesson', 'note'])

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export class MemoryStore {
  /**
   * @param {{ file?: string | null, limit?: number, now?: () => number }} [options]
   */
  constructor({ file = null, limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
    this.file = file
    this.limit = Math.max(10, Number(limit) || DEFAULT_LIMIT)
    this.now = now
    /** @type {Array<{ id: string, kind: string, text: string, data: any, at: number, hits: number }>} */
    this.entries = []
    this.loaded = false
    this.error = null
    this.seq = 0
  }

  get size() {
    return this.entries.length
  }

  /** Read the file if it exists. Corrupt/unreadable files are reported, not fatal. */
  load(file = this.file) {
    if (!file) return this
    this.file = file
    this.loaded = true
    try {
      if (!fs.existsSync(file)) return this
      const raw = fs.readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries
      if (!Array.isArray(entries)) throw new Error('unexpected memory file shape')
      this.entries = entries
        .filter((entry) => entry && typeof entry.text === 'string')
        .map((entry) => ({
          id: String(entry.id ?? `${entry.kind ?? 'note'}-${this.now().toString(36)}-${this.seq++}`),
          kind: MEMORY_KINDS.has(entry.kind) ? entry.kind : 'note',
          text: clean(entry.text),
          data: entry.data ?? null,
          at: Number(entry.at) || 0,
          hits: Number(entry.hits) || 1,
        }))
        .slice(-this.limit)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    }
    return this
  }

  /** Write the file atomically (tmp + rename). Never throws into a tool path. */
  save() {
    if (!this.file) return false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, entries: this.entries }, null, 2))
      fs.renameSync(tmp, this.file)
      this.error = null
      return true
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /**
   * Add (or refresh) one memory. Identical kind+text bumps `hits` instead of
   * duplicating, which keeps repeated lessons from flooding the file.
   */
  add({ kind = 'note', text = '', data = null } = {}) {
    const normalizedKind = MEMORY_KINDS.has(kind) ? kind : 'note'
    const normalizedText = clean(text)
    if (!normalizedText) throw new Error('MC_MEMORY_EMPTY: 记忆内容不能为空。')
    const existing = this.entries.find((entry) => entry.kind === normalizedKind && entry.text === normalizedText)
    if (existing) {
      existing.at = this.now()
      existing.hits += 1
      if (data !== null && data !== undefined) existing.data = data
      return existing
    }
    const entry = {
      id: `${normalizedKind}-${this.now().toString(36)}-${this.seq++}`,
      kind: normalizedKind,
      text: normalizedText,
      data,
      at: this.now(),
      hits: 1,
    }
    this.entries.push(entry)
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
    return entry
  }

  /** Newest-first list, optionally filtered by kind or substring. */
  list({ kind = null, query = null, limit = 10 } = {}) {
    const needle = query ? clean(query).toLowerCase() : null
    return this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => (kind ? entry.kind === kind : true))
      .filter(({ entry }) => (needle ? entry.text.toLowerCase().includes(needle) : true))
      // Ties on `at` (same millisecond) fall back to insertion order, so
      // "newest first" stays deterministic.
      .sort((a, b) => b.entry.at - a.entry.at || b.index - a.index)
      .slice(0, Math.max(1, Math.min(50, Number(limit) || 10)))
      .map(({ entry }) => entry)
  }

  search(query, limit = 5) {
    return this.list({ query, limit })
  }

  remove(id) {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index === -1) return false
    this.entries.splice(index, 1)
    return true
  }

  /**
   * The few facts worth injecting into every model request: newest place, the
   * newest build, and up to two corrections. Callers keep it to one short line.
   */
  snapshot() {
    const newest = (kind, count = 1) => this.list({ kind, limit: count })
    return {
      place: newest('place', 1),
      build: newest('build', 1),
      corrections: newest('correction', 2),
      lessons: newest('lesson', 1),
      total: this.entries.length,
    }
  }
}
