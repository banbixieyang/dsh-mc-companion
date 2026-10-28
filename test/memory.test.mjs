/**
 * Long-term memory: the facts a companion should not re-learn every session.
 *
 * Covered here: store semantics (dedupe, cap, search, atomic save/load), the
 * one-line prompt injection, and the tool surface the model uses to record a
 * correction.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { install } from '../index.js'
import { MemoryStore } from '../lib/memory.js'
import { createFakeCtx, execContext } from './helpers/fake-ctx.mjs'

async function tmpDir() {
  return mkdtemp(path.join(tmpdir(), 'mc-companion-memory-'))
}

test('memory store: add, dedupe, list and search', () => {
  const store = new MemoryStore({ now: () => 1_700_000_000_000 })
  const first = store.add({ kind: 'place', text: '家 (12,64,-8)' })
  const again = store.add({ kind: 'place', text: '家   (12,64,-8)' }) // whitespace-normalised

  assert.equal(store.size, 1, 'identical facts must not duplicate')
  assert.equal(again.id, first.id)
  assert.equal(again.hits, 2)
  assert.equal(first.text, '家 (12,64,-8)')

  store.add({ kind: 'correction', text: '别在我挖矿时站正前方' })
  store.add({ kind: 'build', text: 'small_house 于 43,-60,42' })

  assert.equal(store.list({ kind: 'correction' }).length, 1)
  assert.equal(store.search('挖矿').length, 1)
  assert.equal(store.search('不存在的东西').length, 0)
  assert.equal(store.snapshot().total, 3)
  assert.equal(store.snapshot().place[0].text, '家 (12,64,-8)')

  const id = store.list({ kind: 'build' })[0].id
  assert.equal(store.remove(id), true)
  assert.equal(store.remove(id), false)
  assert.equal(store.size, 2)
})

test('memory store: empty text is refused and capacity is bounded', () => {
  const store = new MemoryStore({ limit: 10 })
  assert.throws(() => store.add({ kind: 'note', text: '   ' }), /MC_MEMORY_EMPTY/)
  for (let i = 0; i < 25; i += 1) store.add({ kind: 'note', text: `note ${i}` })
  assert.equal(store.size, 10)
  assert.equal(store.list({ limit: 50 })[0].text, 'note 24')
})

test('memory store: save + load round-trips and tolerates a corrupt file', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'memory.json')

  const store = new MemoryStore({ file })
  store.add({ kind: 'place', text: '家 (0,70,0)' })
  store.add({ kind: 'correction', text: '说话短一点' })
  assert.equal(store.save(), true)
  assert.ok(existsSync(file))

  const reloaded = new MemoryStore({ file }).load()
  assert.equal(reloaded.size, 2)
  assert.equal(reloaded.list({ kind: 'place' })[0].text, '家 (0,70,0)')

  await writeFile(file, '{ not json', 'utf8')
  const broken = new MemoryStore({ file }).load()
  assert.equal(broken.size, 0)
  assert.ok(broken.error, 'a corrupt file is reported, not thrown')
})

test('memory store: atomic write leaves no partial file behind', async () => {
  const dir = await tmpDir()
  const file = path.join(dir, 'memory.json')
  const store = new MemoryStore({ file })
  store.add({ kind: 'note', text: 'first' })
  store.save()
  store.add({ kind: 'note', text: 'second' })
  store.save()
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.version, 1)
  assert.equal(parsed.entries.length, 2)
})

test('companion: memory is injected as one compact line', async () => {
  const cwd = await tmpDir()
  const { ctx } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false })
  await companion.enable({ connect: false })

  assert.equal(companion.memoryLine(), '', 'no memory yet means no line')

  companion.remember({ kind: 'place', text: '家 (12,64,-8)' })
  companion.remember({ kind: 'build', text: 'small_house 于 43,-60,42' })
  companion.remember({ kind: 'correction', text: '别在我挖矿时站正前方' })

  const line = companion.memoryLine()
  assert.match(line, /^记忆：家 \(12,64,-8\)/)
  assert.match(line, /上次建造 small_house/)
  assert.match(line, /纠正 别在我挖矿时站正前方/)
  assert.ok(line.length <= 200)

  // The line lands in the live prompt context too.
  companion.bot.bot = {
    version: '1.20.4',
    entity: { position: { x: 0, y: 64, z: 0 } },
    health: 20,
    food: 20,
    game: { dimension: 'overworld' },
    players: {},
    entities: {},
    inventory: { items: () => [] },
  }
  companion.bot.online = true
  assert.match(companion.promptText(), /记忆：家/)
  await ctx.dispose()
})

test('companion: memory file lives under the session working directory', async () => {
  const cwd = await tmpDir()
  const { ctx } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false })
  await companion.enable({ connect: false })

  companion.remember({ kind: 'place', text: '家 (0,70,0)' })
  const file = path.join(cwd, 'data', 'mc-companion', 'memory.json')
  assert.ok(existsSync(file), `expected ${file}`)
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(parsed.entries[0].text, '家 (0,70,0)')
  await ctx.dispose()
})

test('tool: mc_memory remember / recall / forget', async () => {
  const cwd = await tmpDir()
  const { ctx, tools } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false })
  await companion.enable({ connect: false })

  const tool = tools.get('mc_memory')
  assert.ok(tool, 'mc_memory must be registered with the other game tools')
  const exec = execContext()

  const saved = await tool.execute({ action: 'remember', kind: 'correction', text: '别站我正前方' }, exec)
  assert.equal(saved.ok, true)
  assert.equal(saved.total, 1)

  const recalled = await tool.execute({ action: 'recall', kind: 'correction' }, exec)
  assert.equal(recalled.ok, true)
  assert.equal(recalled.entries.length, 1)
  assert.equal(recalled.entries[0].text, '别站我正前方')

  const forgotten = await tool.execute({ action: 'forget', id: recalled.entries[0].id }, exec)
  assert.equal(forgotten.removed, true)
  assert.equal(forgotten.total, 0)

  const bad = await tool.execute({ action: 'explode' }, exec)
  assert.equal(bad.ok, false)
  assert.equal(bad.error, 'MC_MEMORY_BAD_ACTION')
  await ctx.dispose()
})

test('interrupts leave a short lesson in memory', async () => {
  const cwd = await tmpDir()
  const { ctx } = createFakeCtx({ cwd })
  const { companion } = install(ctx, { autoConnect: false })
  await companion.enable({ connect: false })

  companion.tasks.begin({ kind: 'behavior', id: 'run-x', label: '伐木 16 个' })
  companion.behaviors.pause = () => ({ active: true, paused: true })
  companion.interrupt('low_health', '生命 4/20 已到安全下限')

  const lessons = companion.memory.list({ kind: 'lesson' })
  assert.equal(lessons.length, 1)
  assert.match(lessons[0].text, /伐木 16 个 因 low_health 中断/)
  await ctx.dispose()
})
