/**
 * Minecraft 1.19+ requires every `block_dig` packet to echo the `sequence`
 * number the server last sent in `acknowledge_player_digging`. mineflayer 4.x
 * never sends it, so the field serialises as 0; vanilla/Paper treat that as a
 * stale action and silently ignore the dig in survival (creative is exempt,
 * which is why the creative test runs passed).
 *
 * The symptom: the bot swings, `bot.dig()` resolves, the behaviour counts the
 * block as chopped, but nothing breaks and no drops appear.
 *
 * This helper tracks the server sequence and injects it into `block_dig`.
 */
export function installDigSequence (bot, { log = null } = {}) {
  if (!bot?._client || typeof bot._client.write !== 'function') return false
  if (bot._digSequenceInstalled) return true
  const client = bot._client
  const sequenceOf = (name) => {
    // Some protocol versions expose the packet with a different name.
    const type = client.digest?.() ?? null
    void type
    return name
  }

  let sequence = 0
  const onAck = (packet) => {
    // 1.19–26.1 call it `sequence`; 26.3 renamed the field to `sequenceId`.
    const value = packet?.sequence ?? packet?.sequenceId
    if (typeof value === 'number') sequence = value
  }
  client.on('acknowledge_player_digging', onAck)
  // 26.x renames some packets; listen to both spellings when present.
  client.on('player_digging_ack', onAck)

  const originalWrite = client.write.bind(client)
  client.write = (name, params) => {
    if ((name === 'block_dig' || sequenceOf(name) === 'player_action') && params && typeof params === 'object') {
      if (params.sequence === undefined) params = { ...params, sequence }
    }
    return originalWrite(name, params)
  }

  bot._digSequenceInstalled = true
  bot._digSequenceValue = () => sequence
  if (log) log(`dig sequence fix installed (sequence=${sequence})`)
  return true
}

/** Remove the patch (used when a bot is disposed). */
export function uninstallDigSequence (bot) {
  if (!bot?._digSequenceInstalled) return
  bot._digSequenceInstalled = false
}

