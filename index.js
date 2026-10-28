/**
 * dsh-mc-companion — a headless Minecraft companion for DeepSeek Harness.
 *
 * Load-time guarantees (the whole point of this plugin):
 *   - exactly one tool is registered: `mc_companion_mode`;
 *   - no Mineflayer import, no bot, no socket, no timer, no file access;
 *   - the twelve `mc_*` game tools exist only after an explicit enable.
 *
 * See README.md for the demo flow and the acceptance checklist.
 */

import { Companion } from './lib/mode.js'
import { GAME_TOOL_NAMES, gameTools, modeTool } from './lib/tools.js'

/** Stable Loader identity. */
export const name = 'dsh-mc-companion'

/**
 * Hard dependencies: a tool registry to register into, and the Session working
 * directory so schematic files land under ./data/mc-companion/schematics/.
 */
export const inject = ['tools', 'workingDirectory']

/** Tools that only exist while the mode is enabled (exported for tests). */
export { GAME_TOOL_NAMES }

/**
 * Install the plugin into one Cordis context.
 *
 * Exported separately from `apply` so tests can drive the exact same wiring
 * with a fake context, without a running Harness.
 *
 * @param {any} ctx
 * @param {Record<string, any>} [config]
 */
export function install(ctx, config = {}) {
  const companion = new Companion(ctx, config)
  companion.setGameToolDefinitions(gameTools(companion))
  const disposeModeTool = ctx.tools.register(modeTool(companion))

  ctx.effect(() => () => {
    // Fire-and-forget is intentional: Cordis teardown must not hang on a
    // socket that is already closing, and every resource is also released by
    // disable(). The disposers are idempotent.
    companion.dispose().catch(() => {})
    try {
      disposeModeTool()
    } catch {
      /* ignore */
    }
  })

  return { companion, modeToolName: 'mc_companion_mode' }
}

/** Cordis entry point. */
export function apply(ctx, config = {}) {
  return install(ctx, config)
}
