/**
 * Shared fixtures for the scenario eval set.
 *
 * These are deliberately the *real* plugin objects (Companion, tools, prompt
 * context) with a fake mineflayer bot underneath — the scenarios exercise
 * decisions, not block physics.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { install } from '../../index.js'
import { createFakeCtx, execContext } from '../helpers/fake-ctx.mjs'

export { execContext }

/** Position stand-in: only `distanceTo` is used by the guards. */
export const pos = (x, y, z) => ({
  x,
  y,
  z,
  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  },
})

/** Fresh companion with the mode enabled and no bot connection. */
export async function makeCompanion({ config = {}, cwd = null } = {}) {
  const dir = cwd ?? (await mkdtemp(path.join(tmpdir(), 'mc-eval-')))
  const { ctx, tools, contexts, sections } = createFakeCtx({ cwd: dir })
  const { companion } = install(ctx, { autoConnect: false, ...config })
  await companion.enable({ connect: false })
  return {
    dir,
    ctx,
    tools,
    contexts,
    sections,
    companion,
    text: () => contexts.get('mc-companion-status')?.text() ?? '',
  }
}

/** Minimal mineflayer bot covering what perception reads. */
export function fakeBot({
  version = '1.20.4',
  position = pos(0, 64, 0),
  health = 20,
  food = 20,
  dimension = 'overworld',
  gameMode = 'survival',
  players = {},
  entities = {},
  inventory = [],
  heldItem = null,
} = {}) {
  return {
    version,
    entity: { position },
    health,
    food,
    game: { dimension, gameMode },
    players,
    entities,
    inventory: { items: () => inventory },
    heldItem,
    time: { timeOfDay: 6000 },
  }
}

export function attachBot(companion, bot, { follow = null } = {}) {
  companion.bot.bot = bot
  companion.bot.online = true
  companion.bot.follow = follow
  return bot
}

/**
 * Put a synthetic running behaviour on the real runner and mirror it into the
 * task stack, so pause/resume/interrupt run through production code.
 */
export function activeRun(companion, overrides = {}) {
  const run = {
    mode: 'woodcut',
    behavior: { label: '伐木', unit: '个原木' },
    instance: {},
    options: {},
    runId: 'eval-run',
    startedAt: Date.now() - 1_000,
    paused: false,
    pausedAt: 0,
    pausedMs: 0,
    pauseReason: '',
    progress: 3,
    target: 8,
    phase: 'chopping',
    note: '',
    failures: 0,
    timer: null,
    nextMilestone: Infinity,
    ...overrides,
  }
  companion.behaviors.active = run
  companion.tasks.begin({ kind: 'behavior', id: run.runId, label: run.behavior.label })
  return run
}
