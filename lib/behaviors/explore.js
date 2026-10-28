/**
 * Exploration: wander to random waypoints inside a radius, forever.
 *
 * This is the "keep the companion alive and moving" state. It never digs and
 * never fights — it only pathfinds, so it is safe to leave running while the
 * model does something else. Stuck waypoints are abandoned instead of retried,
 * so a wall cannot freeze the loop.
 */
import { clampRadius, withTimeout } from './helpers.js'

const WAYPOINT_TIMEOUT_MS = 20_000
const MIN_RADIUS = 8

export default {
  mode: 'explore',
  label: '自由探索',
  unit: '个路径点',

  prepare ({ bot, pathfinder, options, config }) {
    const radius = Math.max(MIN_RADIUS, clampRadius(options.radius, config))
    const target = 0 // unbounded: explore runs until stopped
    let progress = 0
    let goal = null
    let startedAt = 0
    let lastNote = 'picking waypoint'
    let anchor = bot.entity?.position?.clone?.() ?? null

    const pickWaypoint = () => {
      const origin = anchor ?? bot.entity.position
      const angle = Math.random() * Math.PI * 2
      const distance = MIN_RADIUS + Math.random() * (radius - MIN_RADIUS)
      return {
        x: Math.round(origin.x + Math.cos(angle) * distance),
        z: Math.round(origin.z + Math.sin(angle) * distance)
      }
    }

    return {
      target,
      unit: '个路径点',
      radius,
      get startProgress () {
        return progress
      },
      idlePhase: () => lastNote,

      async step () {
        if (!pathfinder?.goals) {
          // Without the pathfinder module there is nothing to do; report clearly
          // instead of silently standing still.
          return { done: true, reason: 'no_pathfinder', progress, phase: 'no_pathfinder' }
        }

        if (!goal) {
          const waypoint = pickWaypoint()
          goal = waypoint
          startedAt = Date.now()
          lastNote = `walking to ${waypoint.x},${waypoint.z}`
          try {
            bot.pathfinder.setGoal(new pathfinder.goals.GoalXZ(waypoint.x, waypoint.z))
          } catch (error) {
            goal = null
            return { progress, phase: 'goal_failed', note: error instanceof Error ? error.message : 'goal_failed' }
          }
          return { progress, phase: lastNote, note: lastNote }
        }

        const moving = Boolean(bot.pathfinder?.isMoving?.())
        const timedOut = Date.now() - startedAt > WAYPOINT_TIMEOUT_MS
        if (moving && !timedOut) return { progress, phase: lastNote }

        if (timedOut) {
          try {
            bot.pathfinder.setGoal(null)
          } catch {
            /* ignore */
          }
        }
        progress += 1
        anchor = bot.entity?.position?.clone?.() ?? anchor
        goal = null
        lastNote = timedOut ? 'waypoint timed out, picking another' : `reached ${progress} waypoints`
        return { progress, phase: lastNote, note: lastNote }
      },

      cleanup () {
        try {
          bot.pathfinder?.setGoal?.(null)
        } catch {
          /* ignore */
        }
      }
    }
  }
}
