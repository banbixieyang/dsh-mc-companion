import assert from 'node:assert/strict'
import test from 'node:test'

import { AutoChat, Dashboard, installDashboard } from '../lib/dashboard.js'
import { EventLog } from '../lib/events.js'

function fakeCompanion() {
  const events = new EventLog(100)
  const companion = {
    enabled: false,
    config: {
      username: 'Bot',
      host: '127.0.0.1',
      port: 25565,
      owner: 'Owner',
      followRadius: 3,
      behaviors: { explore: false, woodcut: false, mine: false, fight: false },
    },
    events,
    bot: {
      online: false,
      snapshot: () => ({ online: false, username: 'Bot' }),
      connect: async () => ({ online: true }),
      disconnect: async () => ({ disconnected: true }),
      followPlayer: async (name, radius) => ({ player: name, radius }),
      stopFollow() {},
      chat: (message) => ({ message }),
    },
    behaviors: {
      snapshot: () => ({ active: false, allowed: [] }),
      start: (mode, options) => ({ mode, options }),
      stop: () => ({ stopped: true }),
    },
    inbox: {
      items: [
        { id: 'c1', username: 'Alice', message: 'hello', at: 1, owner: false, addressed: true, commandLike: false, replied: false },
        { id: 'c2', username: 'Bob', message: 'cut wood', at: 2, owner: false, addressed: true, commandLike: true, replied: false },
      ],
      pending: () => [],
      markReplied: () => 1,
      markAllReplied: () => 2,
    },
    tasks: { snapshot: () => ({ active: false }) },
    pauseBehavior() {},
    resumeBehavior() {},
    cancelBuild: () => ({ ok: true }),
    setQuiet() {},
    status() {
      return {
        ok: true,
        enabled: this.enabled,
        tools: [],
        bot: this.bot.snapshot(),
        build: null,
        behavior: this.behaviors.snapshot(),
        tasks: this.tasks.snapshot(),
        chat: { total: 2, pending: [], last: [] },
        config: this.config,
        recentEvents: [],
      }
    },
    enable: async () => {
      companion.enabled = true
      return { ok: true, enabled: true }
    },
    disable: async () => {
      companion.enabled = false
      return { ok: true, enabled: false }
    },
  }
  companion.behaviors.snapshot = () => ({
    active: false,
    allowed: Object.keys(companion.config.behaviors).filter((mode) => companion.config.behaviors[mode] === true),
  })
  return companion
}

function fakeCtx() {
  const routes = []
  const effects = []
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (route) => { routes.push(route); return () => {} } }
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    inject(services, callback) {
      callback({
        webServer: { register: (route) => { routes.push(route); return () => {} } },
        effect(fn) {
          const disposer = fn()
          effects.push(disposer)
          return disposer
        },
      })
    },
  }
  return { ctx, routes, effects }
}

test('dashboard state exposes HUD, behaviour cards and chat feed', () => {
  const companion = fakeCompanion()
  const dashboard = new Dashboard({ ctx: fakeCtx().ctx, companion, events: companion.events })
  const state = dashboard.state()
  assert.equal(state.ok, true)
  assert.equal(state.enabled, false)
  assert.equal(Array.isArray(state.behaviors), true)
  assert.deepEqual(state.behaviors.map((b) => b.mode), ['explore', 'woodcut', 'mine', 'fight'])
  assert.equal(state.chat.feed.length, 2)
  assert.equal(state.chat.feed[1].commandLike, true)
  assert.equal(state.dashboard.mounted, false)
})

test('dashboard actions enable the mode and start a work behaviour', async () => {
  const companion = fakeCompanion()
  const { ctx } = fakeCtx()
  const dashboard = new Dashboard({ ctx, companion, events: companion.events })
  const enabled = await dashboard.action({ action: 'mode.enable' })
  assert.equal(enabled.ok, true)
  assert.equal(companion.enabled, true)

  const started = await dashboard.action({ action: 'behavior.toggle', mode: 'woodcut', on: true, amount: 4, radius: 16 })
  assert.equal(started.ok, true)
  assert.equal(companion.config.behaviors.woodcut, true)
  assert.equal(started.state.behaviors.find((b) => b.mode === 'woodcut').allowed, true)

  const stopped = await dashboard.action({ action: 'behavior.toggle', mode: 'woodcut', on: false })
  assert.equal(stopped.ok, true)
  assert.equal(companion.config.behaviors.woodcut, false)
})

test('dashboard registers the two same-origin API routes', () => {
  const companion = fakeCompanion()
  const { ctx, routes } = fakeCtx()
  const dashboard = installDashboard({ ctx, companion })
  assert.equal(dashboard.mounted, true)
  assert.deepEqual(routes.map((route) => route.path).sort(), [
    '/api/mc-companion/action',
    '/api/mc-companion/state',
  ])

  const stateRoute = routes.find((route) => route.path === '/api/mc-companion/state')
  let status = 0
  let body = ''
  stateRoute.handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' } }, {
    writeHead(code) {
      status = code
    },
    end(value) {
      body = value
    },
  })
  assert.equal(status, 200)
  const parsed = JSON.parse(body)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.dashboard.mounted, true)
})

test('command-like chat can never start a behaviour through the dashboard', async () => {
  const companion = fakeCompanion()
  const { ctx } = fakeCtx()
  const dashboard = new Dashboard({ ctx, companion, events: companion.events })
  await dashboard.action({ action: 'mode.enable' })
  // A chat send is just text, even if it looks like an order.
  const sent = await dashboard.action({ action: 'chat.send', message: '砍树' })
  assert.equal(sent.ok, true)
  assert.equal(companion.config.behaviors.woodcut, false)
  assert.deepEqual(Object.values(companion.config.behaviors), [false, false, false, false])
})

test('AutoChat answers social chat, skips command-like lines and never calls a tool', async () => {
  const events = new EventLog(100)
  const sent = []
  const marked = []
  const now = Date.now()
  const pending = [
    { id: 'c1', username: 'Bob', message: '帮我砍树', at: now, addressed: true, commandLike: true, owner: false },
    { id: 'c2', username: 'Alice', message: '你好呀', at: now, addressed: true, commandLike: false, owner: false },
  ]
  const companion = {
    enabled: true,
    config: { username: 'Bot' },
    events,
    bot: {
      online: true,
      snapshot: () => ({ online: true, health: 20, position: { x: 0, y: 64, z: 0 } }),
      chat: (message) => {
        sent.push(message)
        return { message }
      },
    },
    inbox: {
      items: pending,
      pending: () => pending,
      markReplied: (ids) => {
        marked.push(...ids)
        return ids.length
      },
    },
  }
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          async *stream() {
            yield { type: 'text-delta', text: '你好，' }
            yield { type: 'text-delta', text: '我在呢' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
  const auto = new AutoChat({ ctx, companion, events })
  auto.configure({ enabled: true, policy: 'addressed', minIntervalMs: 3000 })
  await auto.tick()
  auto.dispose()

  assert.deepEqual(sent, ['你好，我在呢'])
  assert.deepEqual(marked, ['c2'])
  assert.equal(auto.replies, 1)
  // The command-like line stayed in the inbox; the plugin never acted on it.
  assert.equal(marked.includes('c1'), false)
  assert.equal(companion.config.behaviors, undefined)
})
