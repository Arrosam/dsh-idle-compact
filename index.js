/**
 * Idle Compact — Host half.
 *
 * When a user-facing agent goes idle, arm a timer. If the user has not woken the agent
 * before it fires, its last turn finished normally, no background job or subagent is
 * running, and the measured context has reached the threshold, the plugin PREPARES a
 * compaction: it runs DSH's own `/compact` summarization once, while the provider's KV
 * cache is still warm, and keeps the result without changing the session. The page then
 * shows an "Apply compaction" button. Clicking it runs the real `/compact` command; while
 * that runs, the plugin answers its one summarization request with the prepared result,
 * so applying makes no new LLM call and the chat shows the ordinary `/compact` card and
 * "Compacted N history items" reply.
 *
 * A prepared result is valid only for the exact conversation it summarized: any change to
 * the model-visible history discards it, and the replay is used only for a request that is
 * byte-for-byte the one recorded. Otherwise `/compact` simply makes its own fresh call.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import z from '@deepseek-ai/schemastery'

export const name = 'idle-compact'

/**
 * `ctx.timeout()` is a mixin of the `timer` service, and Cordis exposes service mixins
 * only to plugins that declare the service. Undeclared, the idle timer threw
 * "cannot get property "timer" without inject" inside the `agent/status` listener; the
 * agent event dispatcher logs and swallows listener errors, so nothing ever ran.
 * `commands` executes `/compact`, `llm` carries the summarization request and its
 * `llm/stream` interception hook, `sessions` resolves sessions by id and supplies message
 * projections for the detached copy, and `webServer` serves the page's endpoint. Without
 * any of them this plugin has no work, so all are required.
 */
export const inject = ['timer', 'commands', 'llm', 'sessions', 'webServer']

/** Plugin-owned defaults (requested by the user: 256K tokens, 5 minutes = 300 seconds). */
export const DEFAULTS = Object.freeze({
  contextThresholdTokens: 256_000,
  idleSeconds: 300,
})

/**
 * Page endpoint. `GET ${API_PATH}/events?sessionId=` is a server-sent event stream of that
 * session's prepared state; `POST ${API_PATH}/apply` with JSON `{ sessionId }` applies it.
 */
export const API_PATH = '/dsh-idle-compact/api'
const API_EVENTS = API_PATH + '/events'
const API_APPLY = API_PATH + '/apply'
const JSON_CONTENT_TYPE = 'application/json'
const MAX_BODY_BYTES = 4 * 1024
const HTTP = Object.freeze({ ok: 200, badRequest: 400, forbidden: 403, notFound: 404, methodNotAllowed: 405, conflict: 409, unsupportedMediaType: 415 })

const MS_PER_SECOND = 1_000
const AGENT_STATUS_IDLE = 'idle'
const SUBAGENT_ORIGIN = 'subagent'
/** Only a turn that ended this way counts as finished; errors, aborts, and cut-off turns do not. */
const TURN_END_COMPLETED = 'completed'
/**
 * The exact line a user types. Running it through `ctx.commands.execute` (the same entry
 * the Web composer reaches over RPC) logs `command/run` / `command/done`, so the chat
 * renders the integrated `/compact` card with its "Compacted N history items" reply.
 */
const COMPACT_COMMAND_LINE = '/compact'
const NO_ATTACHMENTS = Object.freeze([])
/** `purpose` DSH's compaction engine stamps on its summarization request. */
const COMPACTION_PURPOSE = 'compaction'
/** `ManualCompactionError.code` for the engine's final durability checkpoint. */
const PERSISTENCE_FAILURE_CODE = 'persistence'
const EVENT_COMPACTION_SUMMARY = 'compaction/summary'
const EVENT_COMPACTION_END = 'compaction/end'
const SERVICE_TOKEN_METER = 'tokenMeter'
const SERVICE_COMPACTION = 'compaction'
const SERVICE_AGENT_PRESETS = 'agentPresets'
/** DSH's archive-admission question: what still runs for a session. */
const EVENT_SESSION_ACTIVITY = 'workspace/session-activity'
/** Activity families that are background work; `schedule` is a future reminder and `turn` is excluded by the idle check. */
const BACKGROUND_ACTIVITY_KINDS = Object.freeze(['job', 'subagent'])

/**
 * `.volatile()` fields are what the Settings service exposes as an editable form;
 * the client page edits them through `configForms` and the Host reads them live.
 */
export const Config = z.object({
  contextThresholdTokens: z.number().step(1).min(1).default(DEFAULTS.contextThresholdTokens)
    .description('Prepare a compaction only when the session context has reached this many tokens.').volatile(),
  idleSeconds: z.number().step(1).min(1).default(DEFAULTS.idleSeconds)
    .description('Seconds without a user reply before a compaction is prepared.').volatile(),
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

/**
 * Model-visible history identity. Surface nodes change only by append (length) or
 * replacement (content generation), so log-only events — including the `command/run`
 * and `compaction/start` that applying itself writes — leave it unchanged.
 */
function surfaceSignature(session) {
  return `${session.surface.contentGeneration}:${session.surface.nodes.length}`
}

/**
 * Identity of one summarization request: everything the engine sends to the provider.
 * The recorded result is replayed only for a request with this exact identity, which
 * proves `/compact` selected the same history and would have sent the same prompt.
 */
function requestKey(options) {
  return JSON.stringify([options.provider, options.model, options.maxTokens ?? null, options.tools ?? null, options.toolHistory ?? null, options.messages])
}

/** Pass a stream through while keeping every chunk for later replay. */
async function* recordStream(stream, chunks) {
  for await (const chunk of stream) {
    chunks.push(chunk)
    yield chunk
  }
}

/** Replay recorded chunks as a stream; consumers only iterate it. */
async function* replayStream(chunks) {
  yield* chunks
}

/** Whether the session's latest turn ended normally (the agent finished, not failed or stopped). */
function lastTurnCompleted(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event?.type === 'turn/end') return event.data.reason?.kind === TURN_END_COMPLETED
  }
  return false
}

/**
 * A detached replay of the session's log. DSH's `Session` class is reached through the
 * live instance rather than imported, so the copy is built by exactly the runtime that
 * built the session (a profile plugin may otherwise resolve a different dsh-session).
 * Appends to a detached session notify no observer and reach no persistence.
 */
function detachedCopy(ctx, session) {
  return session.constructor.create(session.id, session.snapshotEvents(), session.header, session.inheritedEventCount, ctx.sessions.messageProjections)
}

/** The successful compaction a run appended to `session` at or after `fromSeq`, if any. */
function committedSummary(session, fromSeq) {
  let summary
  for (let seq = fromSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event.type === EVENT_COMPACTION_SUMMARY) summary = event.data
    if (event.type === EVENT_COMPACTION_END) return event.data.error === undefined ? summary : undefined
  }
  return undefined
}

/**
 * Refuse requests a browser made on behalf of another site. DSH's web server applies no
 * request policy of its own to plugin routes, so this endpoint states its own: browsers
 * send `Origin` on cross-origin requests, and a page from this host matches it.
 */
function sameOrigin(req) {
  const origin = req.headers?.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

/** Write one JSON response; nothing here is cacheable. */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': `${JSON_CONTENT_TYPE}; charset=utf-8`, 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** Read a small JSON request body, rejecting oversized input. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

export function apply(ctx, config) {
  const logger = ctx.logger(name)
  /** agent -> disposer of its pending idle timer */
  const timers = new Map()
  /** agent -> controller of its in-flight preparation, aborted when the agent resumes */
  const preparing = new Map()
  /** in-flight operations, aborted when the plugin unloads */
  const running = new Set()
  /** session -> `{ agent, key, chunks, signature, items, tokens }`; weak, so a disposed session's entry goes with it */
  const prepared = new WeakMap()
  /** sessions applying their prepared compaction right now */
  const applying = new WeakSet()
  /** sessionId -> open event-stream responses */
  const watchers = new Map()
  /**
   * Which `llm/stream` calls belong to this plugin. A store of `{ record }` marks the
   * preparation's request, `{ entry }` the apply's. The store follows the async call chain
   * from `compactNow` into the request, so a concurrent request for the same session id
   * (the agent's own turn, a typed `/compact`) is never recorded or answered from cache.
   */
  const scope = new AsyncLocalStorage()

  const stateOf = (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    const entry = session === undefined ? undefined : prepared.get(session)
    return entry === undefined
      ? { prepared: false }
      : { prepared: true, items: entry.items, tokens: entry.tokens, applying: applying.has(session) }
  }

  const publish = (session) => {
    const listeners = watchers.get(session.id)
    if (listeners === undefined) return
    const frame = `data: ${JSON.stringify(stateOf(session.id))}\n\n`
    for (const res of listeners) res.write(frame)
  }

  const dropPrepared = (session) => {
    if (!prepared.delete(session)) return
    publish(session)
  }

  /** The prepared entry for a session, dropped if the visible history changed since. */
  const currentPrepared = (session) => {
    const entry = prepared.get(session)
    if (entry === undefined || entry.signature === surfaceSignature(session)) return entry
    dropPrepared(session)
    return undefined
  }

  /** Run one abortable operation, aborted when the plugin unloads. */
  const track = async (operation, controller = new AbortController()) => {
    running.add(controller)
    try { return await operation(controller.signal) } finally { running.delete(controller) }
  }

  const disarm = (agent) => {
    const dispose = timers.get(agent)
    if (dispose !== undefined) { timers.delete(agent); dispose() }
    const controller = preparing.get(agent)
    if (controller !== undefined) { preparing.delete(agent); controller.abort() }
  }

  /** Whether jobs or subagents still run for this session, per DSH's own activity providers. */
  const hasBackgroundWork = async (agent) => {
    const activity = await ctx.waterfall(EVENT_SESSION_ACTIVITY, { sessionId: agent.session.id }, () => Promise.resolve([]))
    return activity.some((family) => BACKGROUND_ACTIVITY_KINDS.includes(family.kind) && family.items.length > 0)
  }

  /**
   * Record DSH's `/compact` summarization for this session without committing it. The
   * engine's normal `compactNow` runs against a detached copy: it selects the range, sends
   * the request (recorded by the `llm/stream` hook), and commits only to the copy, which is
   * then discarded. The live session is never written and its agent is never blocked.
   */
  const prepare = async (agent, compaction, signal) => {
    const session = agent.session
    const signature = surfaceSignature(session)
    const copy = detachedCopy(ctx, session)
    const fromSeq = copy.seq
    const proxy = {
      session: copy,
      options: agent.options,
      // The copy has no driver to serialize against; run the job under this operation's signal.
      runMaintenance: (job) => job(signal),
    }
    const record = { key: undefined, chunks: [] }
    try {
      await scope.run({ record }, () => compaction.compactNow(proxy, signal))
    } catch (error) {
      // The engine ends with a durability checkpoint (`sessions.flush`) that only a live,
      // persisted session can pass. The summary is committed to the copy before it, so
      // this one failure still leaves a complete result to read below.
      if (error?.code !== PERSISTENCE_FAILURE_CODE) throw error
    }
    const summary = committedSummary(copy, fromSeq)
    if (summary === undefined || record.key === undefined) return null
    return { agent, key: record.key, chunks: record.chunks, signature, items: summary.shadowedSeqs.length, tokens: summary.shadowedTokenCount }
  }

  const fire = async (agent) => {
    timers.delete(agent)
    if (agent.status !== AGENT_STATUS_IDLE) {
      logger.info('session %s is busy; idle compaction skipped', agent.id)
      return
    }
    const controller = new AbortController()
    preparing.set(agent, controller)
    try {
      if (!lastTurnCompleted(agent.session)) return
      if (await hasBackgroundWork(agent)) {
        logger.info('session %s has background work running; idle compaction skipped', agent.id)
        return
      }
      const threshold = live(config.contextThresholdTokens, DEFAULTS.contextThresholdTokens)
      const meter = serviceFor(ctx, agent, SERVICE_TOKEN_METER)
      const compaction = serviceFor(ctx, agent, SERVICE_COMPACTION)
      if (meter === undefined || compaction === undefined) {
        logger.debug('session %s: token meter or compaction unavailable; skipped', agent.id)
        return
      }
      const tokens = meter.measure(agent.session).totalTokens
      if (tokens < threshold || currentPrepared(agent.session) !== undefined) return
      logger.info('session %s idle with ~%d tokens (>= %d); preparing compaction', agent.id, tokens, threshold)
      const entry = await track((signal) => prepare(agent, compaction, signal), controller)
      if (entry === null) logger.info('session %s: nothing compactable', agent.id)
      // The user may have resumed while the summary was produced; keep only a still-current result.
      else if (controller.signal.aborted || agent.status !== AGENT_STATUS_IDLE || entry.signature !== surfaceSignature(agent.session)) logger.info('session %s changed while preparing; discarded', agent.id)
      else {
        prepared.set(agent.session, entry)
        publish(agent.session)
        logger.info('session %s: compaction prepared (%d items, ~%d tokens)', agent.id, entry.items, entry.tokens)
      }
    } catch (error) {
      if (!controller.signal.aborted) logger.warn('session %s: idle compaction was not prepared: %s', agent.id, error instanceof Error ? error.message : String(error))
    } finally {
      if (preparing.get(agent) === controller) preparing.delete(agent)
    }
  }

  /** Apply the prepared compaction through the real `/compact` command. */
  const applyPrepared = (session) => track(async (signal) => {
    const entry = currentPrepared(session)
    if (entry === undefined) return { ok: false, code: 'not-prepared' }
    if (applying.has(session)) return { ok: false, code: 'applying' }
    applying.add(session)
    publish(session)
    try {
      const execution = await scope.run({ entry }, () => ctx.commands.execute(entry.agent, COMPACT_COMMAND_LINE, NO_ATTACHMENTS, signal))
      if (execution === undefined) return { ok: false, code: 'command-unavailable' }
      return { ok: execution.result.kind === 'success', result: execution.result }
    } finally {
      applying.delete(session)
      prepared.delete(session)
      publish(session)
    }
  })

  // Record the preparation's request and replay it during apply. Every other request
  // passes through untouched; a waterfall listener must always delegate to `next`.
  ctx.on('llm/stream', (options, next) => {
    const marker = scope.getStore()
    if (marker === undefined || options.purpose !== COMPACTION_PURPOSE) return next()
    const key = requestKey(options)
    if (marker.record !== undefined) {
      // Keep the LAST request: if the engine's summary-error recovery retries, the retry's
      // response is the one that produced the committed summary.
      marker.record.key = key
      marker.record.chunks = []
      return recordStream(next(), marker.record.chunks)
    }
    // Replay at most once, and only for the identical request. Work the apply schedules
    // (a turn woken when maintenance ends) inherits this async context; its own pressure
    // compaction asks something different, or comes after the replay, and goes to the model.
    if (marker.replayed || marker.entry.key !== key) {
      if (!marker.replayed) logger.info('session %s: compaction request differs from the prepared one; making a fresh call', options.sessionId)
      return next()
    }
    marker.replayed = true
    logger.info('session %s: applying prepared compaction without a new LLM call', options.sessionId)
    return replayStream(marker.entry.chunks)
  })

  /** Start (or restart) the idle timer for an agent that is waiting for the user. */
  const arm = (agent) => {
    disarm(agent)
    // Subagents never receive a user reply; compacting them would only spend tokens.
    if (agent.session?.header?.origin === SUBAGENT_ORIGIN) return
    const delayMs = live(config.idleSeconds, DEFAULTS.idleSeconds) * MS_PER_SECOND
    timers.set(agent, ctx.timeout(() => { void fire(agent) }, delayMs))
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === AGENT_STATUS_IDLE) { arm(agent); return }
    disarm(agent)
    // The conversation is moving on; a prepared summary would be stale.
    dropPrepared(agent.session)
  })

  // An agent starts life idle and DSH reports no status change for it: a session resumed
  // after a restart, or reopened later, would otherwise never arm a timer until its next
  // turn. Arm it here too; if it is woken right away, `agent/status` disarms it again.
  // Serial listener: return immediately so agent creation is not delayed.
  ctx.on('agent/created', ({ agent }) => {
    if (agent.status === AGENT_STATUS_IDLE) arm(agent)
  })

  // History changed without a turn (another plugin's message, a rewind): drop the summary.
  ctx.on('session/event', (session) => {
    if (prepared.has(session) && !applying.has(session)) currentPrepared(session)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    disarm(agent)
    dropPrepared(agent.session)
  })

  const openEvents = (req, res, sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (session !== undefined) currentPrepared(session)
    res.writeHead(HTTP.ok, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`data: ${JSON.stringify(stateOf(sessionId))}\n\n`)
    const listeners = watchers.get(sessionId) ?? new Set()
    listeners.add(res)
    watchers.set(sessionId, listeners)
    req.on('close', () => {
      listeners.delete(res)
      if (listeners.size === 0) watchers.delete(sessionId)
    })
  }

  const handleApply = async (req, res) => {
    // Requiring a JSON body makes a cross-site form or no-CORS fetch unable to trigger this.
    if (!String(req.headers?.['content-type'] ?? '').startsWith(JSON_CONTENT_TYPE)) { sendJson(res, HTTP.unsupportedMediaType, { ok: false, code: 'content-type' }); return }
    let body
    try { body = await readJson(req) } catch { sendJson(res, HTTP.badRequest, { ok: false, code: 'bad-body' }); return }
    // A well-formed request is an object naming a session; anything else is the caller's
    // mistake (400), distinct from naming a session that does not exist (404).
    const sessionId = body !== null && typeof body === 'object' && !Array.isArray(body) ? body.sessionId : undefined
    if (typeof sessionId !== 'string' || sessionId === '') { sendJson(res, HTTP.badRequest, { ok: false, code: 'bad-body' }); return }
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) { sendJson(res, HTTP.notFound, { ok: false, code: 'no-session' }); return }
    try {
      const outcome = await applyPrepared(session)
      sendJson(res, outcome.code === 'not-prepared' || outcome.code === 'applying' ? HTTP.conflict : HTTP.ok, outcome)
    } catch (error) {
      sendJson(res, HTTP.ok, { ok: false, code: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!sameOrigin(req)) { sendJson(res, HTTP.forbidden, { ok: false, code: 'origin' }); return }
      const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://local')
      if (url.pathname === API_EVENTS) {
        if (req.method !== 'GET') { sendJson(res, HTTP.methodNotAllowed, { ok: false, code: 'method' }); return }
        openEvents(req, res, url.searchParams.get('sessionId') ?? '')
        return
      }
      if (url.pathname === API_APPLY) {
        if (req.method !== 'POST') { sendJson(res, HTTP.methodNotAllowed, { ok: false, code: 'method' }); return }
        await handleApply(req, res)
        return
      }
      sendJson(res, HTTP.notFound, { ok: false, code: 'route' })
    },
  }), 'idle-compact: api')

  ctx.effect(() => () => {
    for (const dispose of timers.values()) dispose()
    timers.clear()
    for (const controller of preparing.values()) controller.abort()
    preparing.clear()
    for (const controller of running) controller.abort()
    running.clear()
    for (const listeners of watchers.values()) for (const res of listeners) res.end()
    watchers.clear()
  }, 'idle-compact: lifecycle')
}
