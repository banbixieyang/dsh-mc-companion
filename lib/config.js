/**
 * Configuration defaults for `dsh-mc-companion`.
 *
 * The plugin has no Config schema on purpose: every value below is a plain
 * default and the bundle row's `config` block is merged over them in
 * `apply()`. Keeping the module dependency-free means loading the plugin
 * cannot pull in Mineflayer or any Minecraft library.
 */

/** Defaults that make "enable" mean "register tools and go online". */
export const DEFAULTS = Object.freeze({
  /** Connection target used by `mc_companion_mode enable` and `mc_bot_connect`. */
  host: '127.0.0.1',
  port: 25565,
  /** Offline-mode account name. The server sees an ordinary player. */
  username: 'Companion',
  /** Only offline accounts are supported by design (no Microsoft login). */
  auth: 'offline',
  /** Optional protocol version override, e.g. "1.20.4"; null means auto-detect. */
  version: null,
  /**
   * When auto-detection hits a protocol the client stack does not know (e.g. a
   * 26.3 server behind ViaBackwards), retry once with the newest supported
   * client version (26.1).
   */
  autoVersionFallback: true,

  /** Whose chats count as "the owner" and who is followed by default. */
  owner: null,
  /** Follow distance in blocks. */
  followRadius: 3,
  /** Start following the owner automatically after spawn. */
  autoFollow: true,

  /** `enable` connects unless this is false or the caller passes connect:false. */
  autoConnect: true,
  /** How long a connect may take before the tool reports failure. */
  connectTimeoutMs: 20_000,

  /** Schematic storage, relative to the Session working directory. */
  dataDir: 'data/mc-companion',
  schematicDir: null,
  /** Minecraft version used to resolve block state ids when generating schematics. */
  schematicVersion: '1.20.4',
  /** Refuse to generate anything larger than this many blocks. */
  maxSchematicBlocks: 32_768,

  /** Build pacing: block placements per second. */
  buildSpeed: 6,
  /** Interaction reach used by the builder. */
  reach: 4.2,
  /** Test/creative convenience: create missing items with creative inventory slots. */
  allowCreativeFill: false,
  /** Hard cap on blocks placed by a single build task. */
  maxBuildBlocks: 8_192,

  /**
   * Allow the builder to place temporary blocks to escape a pit or climb a
   * wall (mineflayer-pathfinder's 1x1 tower / bridge moves). Only active inside
   * an explicit build task; following never places blocks.
   */
  allowScaffold: true,
  /** Candidate blocks, in preference order, used for scaffolding. */
  scaffoldBlocks: ['dirt', 'cobblestone', 'stone', 'oak_planks', 'oak_log', 'sand'],
  /** How many scaffolding blocks to create in creative mode / aim to reserve. */
  scaffoldBudget: 16,

  /**
   * Send the serverbound `tick_end` packet after movement writes. Vanilla
   * clients do this since 1.21.2; it is required by 26.3 servers and fixes
   * "invalid_player_movement" kicks on 26.3 servers behind ViaBackwards.
   *
   * 'auto' enables it only for client versions >= 1.21.2.
   */
  tickEndCompat: 'auto',

  /**
   * Autonomous behaviours, each explicitly authorised.
   *
   * Everything defaults to false: enabling the companion mode gives you a
   * follower, not a machine that eats someone's base. `mc_behavior` refuses a
   * mode that is not listed here and says which ones are allowed.
   */
  behaviors: Object.freeze({
    explore: false,
    woodcut: false,
    mine: false,
    fight: false
  }),
  /** Default search radius for behaviours (blocks); callers may shrink it. */
  behaviorRadius: 32,
  /** Stop any behaviour when health drops to this value. */
  behaviorMinHealth: 6,
  /** Hard cap per behaviour run in milliseconds (0 = unbounded, e.g. explore). */
  behaviorMaxDurationMs: 120_000,
  /** Do not dig within `behaviorProtectDistance` of another player. */
  behaviorProtectPlayers: true,
  behaviorProtectDistance: 3,
  /** Extra block names that must never be dug, on top of the built-in list. */
  behaviorDigBlacklist: [],
  /** Default combat targets; see lib/behaviors/targets.js. */
  behaviorFightTargets: [],

  /**
   * Idle reflexes: what the bot does between model turns. Deliberately
   * non-destructive — it eats, fights back, flees, picks up drops, respawns and
   * optionally keeps up with the owner, but it never digs or attacks players.
   */
  autopilot: Object.freeze({
    enabled: true,
    eat: true,
    eatThreshold: 16,
    defend: true,
    flee: true,
    fleeHealth: 6,
    pickup: true,
    pickupRadius: 8,
    respawn: true,
    followOwner: false,
    followOwnerDistance: 16
  }),

  /** Longest single `mc_goto` trip in blocks; longer trips must be split. */
  gotoMaxDistance: 128,
  /** Default `mc_goto` time budget (ms). */
  gotoTimeoutMs: 60_000,

  /**
   * Interrupt guards for long-running tasks. A companion has to react before a
   * macro finishes: these thresholds pause the active task and report why.
   *
   * - `interruptDistance`: pause when the followed player is farther than this;
   * - `interruptOnChat`: pause a running behaviour when a player speaks, so the
   *   companion answers instead of silently chopping trees.
   */
  interruptDistance: 24,
  interruptOnChat: true,

  /**
   * Proactivity: a small set of world events becomes a one-line suggestion in
   * the prompt. `speak` lets the bot say it on its own; `quiet` silences
   * everything. Nothing here changes the world.
   */
  proactive: Object.freeze({
    enabled: true,
    speak: false,
    quiet: false,
    cooldownMs: 120_000,
    nearDistance: 8,
  }),

  /**
   * In-game chat policy: the companion talks to everyone, but game chat is
   * never a control channel — only the DSH user gives orders.
   */
  chat: Object.freeze({
    includeAllPlayers: true,
    pendingTtlMs: 300_000,
  }),

  /** Event buffer size used by mc_status / mc_events. */
  eventLimit: 500,
  /** Character budget for the live prompt context. */
  contextChars: 1_200,
})

/** Merge raw row config over the defaults, keeping only known keys. */
export function normalizeConfig(raw) {
  const out = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined || value === null) continue
    out[key] = value
  }
  out.port = Number(out.port) || DEFAULTS.port
  out.followRadius = Number(out.followRadius) || DEFAULTS.followRadius
  out.connectTimeoutMs = Number(out.connectTimeoutMs) || DEFAULTS.connectTimeoutMs
  out.buildSpeed = Math.max(1, Number(out.buildSpeed) || DEFAULTS.buildSpeed)
  out.reach = Math.min(6, Math.max(2, Number(out.reach) || DEFAULTS.reach))
  out.eventLimit = Math.max(50, Number(out.eventLimit) || DEFAULTS.eventLimit)
  out.contextChars = Math.max(300, Number(out.contextChars) || DEFAULTS.contextChars)
  out.autoFollow = out.autoFollow !== false
  out.autoConnect = out.autoConnect !== false
  out.autoVersionFallback = out.autoVersionFallback !== false
  out.allowCreativeFill = out.allowCreativeFill === true
  out.allowScaffold = out.allowScaffold !== false
  out.scaffoldBudget = Math.max(1, Math.min(128, Number(out.scaffoldBudget) || DEFAULTS.scaffoldBudget))
  if (!Array.isArray(out.scaffoldBlocks) || out.scaffoldBlocks.length === 0) {
    out.scaffoldBlocks = [...DEFAULTS.scaffoldBlocks]
  }
  out.scaffoldBlocks = out.scaffoldBlocks.map((name) => String(name)).filter(Boolean)
  if (!['auto', 'always', 'off'].includes(out.tickEndCompat)) out.tickEndCompat = DEFAULTS.tickEndCompat

  // Behaviours: only known modes, only booleans, default false.
  const rawBehaviors = raw.behaviors && typeof raw.behaviors === 'object' && !Array.isArray(raw.behaviors) ? raw.behaviors : {}
  out.behaviors = {}
  for (const mode of Object.keys(DEFAULTS.behaviors)) {
    out.behaviors[mode] = rawBehaviors[mode] === true
  }
  out.behaviorRadius = Math.max(4, Math.min(64, Number(out.behaviorRadius) || DEFAULTS.behaviorRadius))
  out.behaviorMinHealth = Math.max(1, Math.min(20, Number(out.behaviorMinHealth) ?? DEFAULTS.behaviorMinHealth))
  out.behaviorMaxDurationMs = Math.max(0, Number(out.behaviorMaxDurationMs) || DEFAULTS.behaviorMaxDurationMs)
  out.behaviorProtectPlayers = out.behaviorProtectPlayers !== false
  out.behaviorProtectDistance = Math.max(1, Math.min(16, Number(out.behaviorProtectDistance) || DEFAULTS.behaviorProtectDistance))
  out.behaviorDigBlacklist = Array.isArray(out.behaviorDigBlacklist)
    ? out.behaviorDigBlacklist.map((name) => String(name).replace(/^minecraft:/, '')).filter(Boolean)
    : []
  out.behaviorFightTargets = Array.isArray(out.behaviorFightTargets)
    ? out.behaviorFightTargets.map((name) => String(name).replace(/^minecraft:/, '')).filter(Boolean)
    : []
  out.interruptDistance = Math.max(4, Math.min(128, Number(out.interruptDistance) || DEFAULTS.interruptDistance))
  out.interruptOnChat = out.interruptOnChat !== false

  const rawProactive = raw.proactive && typeof raw.proactive === 'object' && !Array.isArray(raw.proactive) ? raw.proactive : {}
  out.proactive = {
    enabled: rawProactive.enabled !== false,
    speak: rawProactive.speak === true,
    quiet: rawProactive.quiet === true,
    cooldownMs: Math.max(30_000, Math.min(3_600_000, Number(rawProactive.cooldownMs) || DEFAULTS.proactive.cooldownMs)),
    nearDistance: Math.max(2, Math.min(16, Number(rawProactive.nearDistance) || DEFAULTS.proactive.nearDistance)),
  }

  const rawChat = raw.chat && typeof raw.chat === 'object' && !Array.isArray(raw.chat) ? raw.chat : {}
  out.chat = {
    includeAllPlayers: rawChat.includeAllPlayers !== false,
    pendingTtlMs: Math.max(10_000, Math.min(3_600_000, Number(rawChat.pendingTtlMs) || DEFAULTS.chat.pendingTtlMs)),
  }

  const rawAutopilot = raw.autopilot && typeof raw.autopilot === 'object' && !Array.isArray(raw.autopilot) ? raw.autopilot : {}
  out.autopilot = { ...DEFAULTS.autopilot }
  for (const key of Object.keys(DEFAULTS.autopilot)) {
    if (rawAutopilot[key] === undefined) continue
    out.autopilot[key] = typeof DEFAULTS.autopilot[key] === 'boolean' ? rawAutopilot[key] === true : Number(rawAutopilot[key])
  }
  out.gotoMaxDistance = Math.max(8, Math.min(512, Number(out.gotoMaxDistance) || DEFAULTS.gotoMaxDistance))
  out.gotoTimeoutMs = Math.max(2_000, Math.min(300_000, Number(out.gotoTimeoutMs) || DEFAULTS.gotoTimeoutMs))
  return out
}

/** Safe subset of the config shown in tool results. */
export function describeConfig(config) {
  return {
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    version: config.version,
    autoVersionFallback: config.autoVersionFallback,
    owner: config.owner,
    followRadius: config.followRadius,
    autoFollow: config.autoFollow,
    autoConnect: config.autoConnect,
    schematicVersion: config.schematicVersion,
    buildSpeed: config.buildSpeed,
    allowCreativeFill: config.allowCreativeFill,
    allowScaffold: config.allowScaffold,
    scaffoldBlocks: config.scaffoldBlocks,
    tickEndCompat: config.tickEndCompat,
    behaviors: config.behaviors,
    behaviorRadius: config.behaviorRadius,
    behaviorMinHealth: config.behaviorMinHealth,
    interruptDistance: config.interruptDistance,
    interruptOnChat: config.interruptOnChat,
    proactive: config.proactive,
    chat: config.chat,
  }
}


