/**
 * Idle Compact — Host half.
 *
 * When a user-facing agent goes idle, arm a timer. If the user has not woken the
 * agent again before the timer fires and the session's measured context exceeds
 * the threshold, run one manual-style compaction. Compacting while the provider's
 * KV cache is still warm makes the summarization request cheap, and the next user
 * turn then starts from a much shorter prompt instead of re-billing the full
 * history at uncached rates.
 */
import z from '@deepseek-ai/schemastery'

export const name = 'idle-compact'

/** Plugin-owned defaults (requested by the user: 256K tokens, 5 minutes = 300 seconds). */
export const DEFAULTS = Object.freeze({
  contextThresholdTokens: 256_000,
  idleSeconds: 300,
})

const MS_PER_SECOND = 1_000
const AGENT_STATUS_IDLE = 'idle'
const SUBAGENT_ORIGIN = 'subagent'
const SERVICE_COMPACTION = 'compaction'
const SERVICE_TOKEN_METER = 'tokenMeter'
const SERVICE_AGENT_PRESETS = 'agentPresets'

/**
 * `.volatile()` fields are what the Settings service exposes as an editable form;
 * the client page edits them through `configForms` and the Host reads them live.
 */
export const Config = z.object({
  contextThresholdTokens: z.number().step(1).min(1).default(DEFAULTS.contextThresholdTokens)
    .description('Compact only when the session context is longer than this many tokens.').volatile(),
  idleSeconds: z.number().step(1).min(1).default(DEFAULTS.idleSeconds)
    .description('Seconds without a user reply before the session is compacted.').volatile(),
})

/** Read a volatile reference (`.get()`) or a plain value. */
function live(value, fallback) {
  const v = value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Resolve a service as the agent sees it. Compaction is mounted inside each agent
 * preset's isolated group, so the root context alone may not carry it.
 */
function serviceFor(ctx, agent, key) {
  return agent.ctx?.get?.(key)
    ?? ctx.get(SERVICE_AGENT_PRESETS)?.serviceFor?.(agent, key)
    ?? ctx.get(key)
}

export function apply(ctx, config) {
  const logger = ctx.logger(name)
  /** agent -> disposer of its pending idle timer */
  const timers = new Map()
  /** in-flight compactions, aborted when the plugin unloads */
  const running = new Set()

  const disarm = (agent) => {
    const dispose = timers.get(agent)
    if (dispose === undefined) return
    timers.delete(agent)
    dispose()
  }

  const fire = async (agent) => {
    timers.delete(agent)
    if (agent.status !== AGENT_STATUS_IDLE) return
    const threshold = live(config.contextThresholdTokens, DEFAULTS.contextThresholdTokens)
    const meter = serviceFor(ctx, agent, SERVICE_TOKEN_METER)
    const compaction = serviceFor(ctx, agent, SERVICE_COMPACTION)
    if (meter === undefined || compaction === undefined) {
      logger.debug('session %s: compaction or token meter unavailable; skipped', agent.id)
      return
    }
    const tokens = meter.measure(agent.session).totalTokens
    if (tokens <= threshold) return
    const controller = new AbortController()
    running.add(controller)
    try {
      logger.info('session %s idle with ~%d tokens (> %d); compacting', agent.id, tokens, threshold)
      const result = await compaction.compactNow(agent, controller.signal)
      if (result === null) logger.info('session %s: nothing compactable', agent.id)
      else logger.info('session %s: compacted %d items (~%d tokens)', agent.id, result.shadowedSeqs.length, result.shadowedTokenCount)
    } catch (error) {
      // `busy` means the user (or other work) woke the agent first — expected, not a fault.
      logger.warn('session %s: idle compaction did not run: %s', agent.id, error instanceof Error ? error.message : String(error))
    } finally {
      running.delete(controller)
    }
  }

  ctx.on('agent/status', ({ agent, status }) => {
    disarm(agent)
    if (status !== AGENT_STATUS_IDLE) return
    // Subagents never receive a user reply; compacting them would only spend tokens.
    if (agent.session?.header?.origin === SUBAGENT_ORIGIN) return
    const delayMs = live(config.idleSeconds, DEFAULTS.idleSeconds) * MS_PER_SECOND
    timers.set(agent, ctx.timeout(() => { void fire(agent) }, delayMs))
  })

  ctx.on('agent/disposed', ({ agent }) => { disarm(agent) })

  ctx.effect(() => () => {
    for (const dispose of timers.values()) dispose()
    timers.clear()
    for (const controller of running) controller.abort()
    running.clear()
  }, 'idle-compact: timers')
}
