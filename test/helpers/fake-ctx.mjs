/**
 * A minimal Cordis-like context for tests.
 *
 * It implements exactly the surface `dsh-mc-companion` uses: a tool registry
 * with disposers, a working-directory service, a system-prompt registrar, and
 * `ctx.effect`. Nothing here touches a real Harness.
 */

export function createFakeCtx({ cwd, prompt = true } = {}) {
  const tools = new Map()
  const effects = []
  const disposedTools = []

  const sections = new Map()
  const contexts = new Map()

  const systemPrompt = prompt
    ? {
        section(definition) {
          if (sections.has(definition.name)) throw new Error(`duplicate section ${definition.name}`)
          sections.set(definition.name, definition)
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            sections.delete(definition.name)
          }
        },
        context(definition) {
          if (contexts.has(definition.name)) throw new Error(`duplicate context ${definition.name}`)
          contexts.set(definition.name, definition)
          let disposed = false
          return () => {
            if (disposed) return
            disposed = true
            contexts.delete(definition.name)
          }
        },
      }
    : null

  const workingDirectory = {
    defaultDirectory: cwd ?? process.cwd(),
    ensure: async () => cwd ?? process.cwd(),
    get: () => cwd ?? process.cwd(),
    set: async () => cwd ?? process.cwd(),
  }

  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        let disposed = false
        return () => {
          if (disposed) return
          disposed = true
          tools.delete(definition.name)
          disposedTools.push(definition.name)
        }
      },
      get(name) {
        return tools.get(name)
      },
      names() {
        return [...tools.keys()]
      },
    },
    workingDirectory,
    systemPrompt,
    get(service) {
      if (service === 'tools') return ctx.tools
      if (service === 'workingDirectory') return workingDirectory
      if (service === 'systemPrompt') return systemPrompt
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    async dispose() {
      for (const disposer of effects.reverse()) {
        if (typeof disposer === 'function') await disposer()
      }
      effects.length = 0
    },
  }

  return {
    ctx,
    tools,
    sections,
    contexts,
    disposedTools,
    systemPrompt,
    effects,
  }
}

/** A fake tool execution context (agent + abort signal). */
export function execContext(agent = { id: 'session-test' }) {
  const controller = new AbortController()
  return {
    agent,
    signal: controller.signal,
    controller,
    deferContext() {},
    concludeTurn() {},
  }
}
