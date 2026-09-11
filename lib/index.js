/**
 * dsh-remote-dsh — Node half.
 *
 * Runs inside a DSH host process. Which half of the feature it owns depends on
 * the row's `role` config:
 *
 *  - `local` (default): the remote-host registry (`$DSH_HOME/remote-dsh.json`)
 *    plus the `/api/remote-dsh` route family — hosts CRUD and a liveness probe.
 *  - `peer`: this host publishes its OWN session state on a loopback route, and
 *    suppresses the browser half through an index injection. That report also
 *    names the sessions blocked waiting for a human, learned by joining the two
 *    pending-interaction waterfalls — see {@link observePendingInteractions}.
 *
 * Peer mode exists because DSH sends no CORS headers, so a local page can never
 * read a remote `/api`, and a remote `/api` cookie is HttpOnly, so the page
 * could not hand it to its own Host half either. The only ways to learn a remote
 * instance's state are therefore "hold a credential" or "let the remote report
 * it" — this is the second, and it needs no credential on either side.
 *
 * Why a peer route is reachable at all: a local port forward (ssh -L, frpc
 * visitor) terminates the connection on the REMOTE's loopback, so the peer's
 * loopback fence passes exactly as it does for a local browser.
 *
 * This file is hand-authored and dependency-free — no build step, and no bare
 * specifier that would need resolution my own package directory cannot provide.
 *
 * @module dsh-remote-dsh
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/** Prefix claimed on the web server. Longer than `/api`, so it wins the longest-prefix match. */
const ROUTE_PREFIX = '/api/remote-dsh'

/** Path a peer serves its own session state on. */
const SELF_STATUS_PATH = '/api/remote-dsh/self-status'

/** Registry file schema version. */
const CONFIG_VERSION = 1

/**
 * State-payload contract version. A reader ignores a peer reporting one it does
 * not know.
 *
 * 3 — `{ running, ageMs }` rows.
 * 4 — a row may additionally carry `pending`.
 *
 * The field is additive, so a v4 reader still reads a v3 peer (its rows simply
 * never carry `pending`) and a v3 reader still reads a v4 peer (it ignores the
 * field). The bump only makes the addition visible to anything inspecting the
 * payload by hand.
 */
const STATUS_VERSION = 4

/** Upper bound on session rows one peer report carries. */
const STATUS_SESSION_CAP = 500

/** Bound on a request body this plugin will read. */
const MAX_BODY_BYTES = 64 * 1024

/** Bound on one probe round-trip. */
const PROBE_TIMEOUT_MS = 3000

/** Bound on one session-list read inside the peer route. */
const STATUS_TIMEOUT_MS = 3000

/** How much of a probed response body is kept for DSH fingerprinting. */
const PROBE_BODY_BYTES = 1024

/** Required services. `sessionController` is read optionally at request time. */
export const inject = ['webServer']

/**
 * Resolve the harness home the same way the rest of DSH does: an explicit
 * `DSH_HOME`, else `~/.dsh`.
 * @returns absolute harness home path.
 */
function dshHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') {
    return env.trim().replace(/^~(?=\/|$)/u, homedir())
  }
  return join(homedir(), '.dsh')
}

/**
 * Whether a hostname is loopback.
 * @param name - hostname from a parsed URL.
 * @returns true for the loopback spellings.
 */
export function isLoopbackHostname(name) {
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]'
}

/**
 * Normalize a user-supplied remote address to a bare origin.
 *
 * Only `http:`/`https:` survive, and the result is `scheme://host:port` with no
 * path, query, or fragment — the panel always embeds the remote root.
 * @param value - raw address from the request body.
 * @returns the normalized origin.
 * @throws when the value is not a usable http(s) URL.
 */
function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('url is required')
  }
  let parsed
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error(`url is not a valid URL: ${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`url must use http or https, got ${parsed.protocol}`)
  }
  return parsed.origin
}

/**
 * Whether an origin's hostname is loopback.
 *
 * This is not a security check — it is the design premise. The remote DSH's
 * browser-session cookie is `HttpOnly; SameSite=Strict`, so a remote reachable
 * only at a public domain cannot be embedded: the iframe is cross-site, the
 * cookie is withheld, and even the remote's index.html answers 401. A loopback
 * address is same-site with the GUI page (SameSite ignores the port), which is
 * what makes the cookie flow.
 * @param origin - normalized origin.
 * @returns true when the hostname is loopback.
 */
export function isLoopbackOrigin(origin) {
  try {
    return isLoopbackHostname(new URL(origin).hostname)
  } catch {
    return false
  }
}

/**
 * Loopback fence for the plugin's own routes.
 *
 * `/api/remote-dsh` is matched by the web server's longest-prefix rule, so the
 * Connection plugin's fence never runs for these requests and this handler owns
 * the decision. The posture mirrors `isTrustedApiRequest`: bind on the socket
 * peer and the Host header, refuse an explicit cross-site marker, and require
 * any attached Origin to equal the Host.
 *
 * `allowLoopbackOrigin` is the one deliberate widening, used only by the
 * read-only peer status route: a page on ANOTHER loopback port (the local DSH
 * GUI at 127.0.0.1:3080 reading a peer at 127.0.0.1:3081) is same-site but
 * cross-origin, so its Origin cannot equal the Host. Accepting a loopback
 * Origin there lets the local GUI read peer state directly instead of routing
 * it through a Host half — and the payload is counts only, never session ids,
 * titles, or content.
 * @param request - incoming Node request.
 * @param allowLoopbackOrigin - accept any loopback Origin (never a remote one).
 * @returns true when the request may reach the route family.
 */
function isLoopbackRequest(request, allowLoopbackOrigin) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  if (originUrl.host === hostUrl.host) return true
  return allowLoopbackOrigin === true && isLoopbackHostname(originUrl.hostname)
}

/**
 * Write one JSON response, optionally as a CORS-readable loopback response.
 * @param response - Node response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable payload.
 * @param origin - the request Origin to allow, when the caller widened the fence.
 */
function writeJson(response, status, body, origin) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  }
  if (origin !== undefined) {
    headers['access-control-allow-origin'] = origin
    headers['vary'] = 'Origin'
  }
  response.writeHead(status, headers)
  response.end(JSON.stringify(body))
}

/**
 * Read and parse a bounded JSON request body.
 * @param request - incoming Node request.
 * @returns the parsed body (an empty object when the body is empty).
 * @throws when the body is oversized or not valid JSON.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/**
 * The remote-host registry: one JSON file, read on demand, written atomically.
 *
 * Reads are deliberately uncached so an external edit to the file is picked up
 * without a host restart; the file is small and this is not a hot path.
 */
export class Registry {
  /**
   * @param file - absolute path of the registry JSON file.
   */
  constructor(file) {
    this.file = file
  }

  /**
   * Read the stored hosts, tolerating an absent or unreadable file.
   * @returns the host rows in stored order.
   */
  read() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`remote-dsh: ${this.file} is not valid JSON`)
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.hosts)) return []
    return parsed.hosts
      .filter(host => host !== null && typeof host === 'object')
      .map(host => ({
        id: typeof host.id === 'string' && host.id !== '' ? host.id : randomUUID(),
        name: typeof host.name === 'string' && host.name !== '' ? host.name : 'remote',
        url: typeof host.url === 'string' ? host.url : '',
      }))
      .filter(host => host.url !== '')
  }

  /**
   * Replace the stored host list.
   * @param hosts - the complete list to persist.
   */
  write(hosts) {
    mkdirSync(dirname(this.file), { recursive: true })
    const payload = `${JSON.stringify({ version: CONFIG_VERSION, hosts }, null, 2)}\n`
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, payload, { mode: 0o600 })
    renameSync(temporary, this.file)
  }

  /**
   * Insert or update one host.
   * @param input - `{ id?, name?, url }` from the request body.
   * @returns the resulting host list.
   */
  upsert(input) {
    const url = normalizeOrigin(input.url)
    const name = typeof input.name === 'string' && input.name.trim() !== ''
      ? input.name.trim()
      : new URL(url).hostname
    const hosts = this.read()
    const id = typeof input.id === 'string' && input.id !== '' ? input.id : randomUUID()
    const at = hosts.findIndex(host => host.id === id)
    const row = { id, name, url }
    if (at === -1) hosts.push(row)
    else hosts[at] = row
    this.write(hosts)
    return hosts
  }

  /**
   * Remove one host by id. Removing an unknown id is a no-op.
   * @param id - host id.
   * @returns the resulting host list.
   */
  remove(id) {
    const hosts = this.read().filter(host => host.id !== id)
    this.write(hosts)
    return hosts
  }
}

/**
 * Probe a remote origin from Node.
 *
 * The remote DSH answers an unauthenticated `GET /` with 401 and the body
 * `dsh web authentication required; reopen the URL printed by dsh web.`, which
 * is both proof that the port is a live DSH and proof that this browser has not
 * paired with it yet.
 * @param origin - normalized origin to probe.
 * @returns a status record; never throws for a network failure.
 */
export function probeOrigin(origin) {
  return new Promise(resolve => {
    const started = Date.now()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve({ ...result, elapsedMs: Date.now() - started })
    }

    let target
    try {
      target = new URL(origin)
    } catch {
      finish({ reachable: false, error: 'invalid-url' })
      return
    }

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : target.port,
      path: '/',
      method: 'GET',
      headers: { accept: 'text/html', 'user-agent': 'dsh-remote-dsh/0.1' },
      timeout: PROBE_TIMEOUT_MS,
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        if (size >= PROBE_BODY_BYTES) return
        size += chunk.length
        chunks.push(chunk)
      })
      response.on('end', () => {
        const body = Buffer.concat(chunks).subarray(0, PROBE_BODY_BYTES).toString('utf8')
        finish({
          reachable: true,
          status: response.statusCode,
          dshAuthRequired: /dsh web authentication required/iu.test(body),
        })
      })
      response.on('error', error => finish({ reachable: false, error: String(error?.code ?? error?.message ?? error) }))
    })
    request.on('timeout', () => {
      request.destroy(new Error('probe timed out'))
    })
    request.on('error', error => {
      finish({ reachable: false, error: String(error?.code ?? error?.message ?? error) })
    })
    request.end()
  })
}

/** Outcome of a session blocked on a human, ranked most-specific first. */
const PENDING_RANK = Object.freeze({ approval: 1, question: 2, 'plan-review': 3 })

/**
 * Live "a Session-scoped UI consumer is awaiting this user" register.
 *
 * The browser assembles the amber sidebar dot from pending-interaction domains
 * that `ui-approval` and `ui-user-questions` register, so no Host service
 * exposes the state as data. What the Host DOES have is the request itself: both
 * packages dispatch a scope-filtered waterfall and only settle when an answerer
 * returns. Holding those two waterfalls open is therefore an exact reading of
 * "this session is waiting for a human", which is what a headless peer needs.
 *
 * A session may hold more than one open request (a nested ask), so each entry is
 * keyed by an opaque token and the reported kind is the highest-ranked one still
 * open — the same precedence the client's pending domains use.
 *
 * @returns a tracker with `track`, `release` handles, and `entries`.
 */
export function createPendingTracker() {
  const bySession = new Map()
  const kindOf = (sessionId) => {
    const open = bySession.get(sessionId)
    if (open === undefined) return undefined
    let best
    for (const kind of open.values()) {
      if (best === undefined || PENDING_RANK[kind] > PENDING_RANK[best]) best = kind
    }
    return best
  }
  return {
    /**
     * Record one open request.
     * @param sessionId - the session that is now waiting.
     * @param kind - `approval`, `question`, or `plan-review`.
     * @returns an idempotent release function.
     */
    track(sessionId, kind) {
      let open = bySession.get(sessionId)
      if (open === undefined) {
        open = new Map()
        bySession.set(sessionId, open)
      }
      const token = Symbol(kind)
      open.set(token, kind)
      return () => {
        const current = bySession.get(sessionId)
        if (current === undefined) return
        current.delete(token)
        if (current.size === 0) bySession.delete(sessionId)
      }
    },
    /**
     * The kind currently shown for one session.
     * @param sessionId - session to read.
     * @returns the highest-ranked open kind, or undefined when none is open.
     */
    kindOf,
    /**
     * Every session with something open, already collapsed per session.
     * @returns `[sessionId, kind]` pairs.
     */
    entries() {
      const rows = []
      for (const sessionId of Array.from(bySession.keys())) {
        const kind = kindOf(sessionId)
        if (kind !== undefined) rows.push([sessionId, kind])
      }
      return rows
    },
  }
}

/**
 * Read the session an interaction request belongs to.
 * @param request - an approval or user-questions request event.
 * @returns the session id, or undefined when the request carries no agent.
 */
function requestSessionId(request) {
  const agent = request === null || typeof request !== 'object' ? undefined : request.agent
  const session = agent === null || typeof agent !== 'object' ? undefined : agent.session
  const id = session === null || typeof session !== 'object' ? undefined : session.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Classify a user-questions request the way the Workspace row does.
 *
 * A plan submitted for review is a `question` tagged with the `plan-review`
 * presentation intent, so the tag — not the option labels — decides the row.
 * @param request - a user-questions request event.
 * @returns `plan-review` or `question`.
 */
function questionKind(request) {
  const questions = request === null || typeof request !== 'object' ? undefined : request.questions
  if (!Array.isArray(questions)) return 'question'
  return questions.some(question => question?.intent?.kind === 'plan-review') ? 'plan-review' : 'question'
}

/**
 * Run one waterfall step while holding the tracker open for its lifetime.
 *
 * This is a transparent chain link: it records the request, delegates with
 * `next()`, and releases on whichever way the downstream chain settles. It never
 * answers, never swallows, and never changes the outcome — the only observable
 * difference is that a synchronous throw from a later listener still propagates.
 * @param tracker - the peer's register.
 * @param sessionId - session the request belongs to, or undefined.
 * @param kind - kind to record.
 * @param next - the waterfall's continuation.
 * @returns the downstream outcome.
 */
function holdPending(tracker, sessionId, kind, next) {
  if (sessionId === undefined) return next()
  const release = tracker.track(sessionId, kind)
  let outcome
  try {
    outcome = next()
  } catch (error) {
    release()
    throw error
  }
  return Promise.resolve(outcome).then(
    (value) => {
      release()
      return value
    },
    (error) => {
      release()
      throw error
    },
  )
}

/**
 * Track every request that leaves a session waiting for a human.
 *
 * Both events are scope-filtered waterfalls that the Host dispatches at the root
 * context, exactly as the Remote-event bridge does, so a plain root listener
 * sees them. Registering is therefore a read, not a takeover: the request still
 * reaches the browser that will answer it.
 * @param ctx - host context.
 * @param tracker - the peer's register.
 * @returns the disposer removing both listeners.
 */
export function observePendingInteractions(ctx, tracker) {
  const offApproval = ctx.on('approval/request', function (request, next) {
    return holdPending(tracker, requestSessionId(request), 'approval', next)
  })
  const offQuestions = ctx.on('user-questions/request', function (request, next) {
    return holdPending(tracker, requestSessionId(request), questionKind(request), next)
  })
  return () => {
    offApproval()
    offQuestions()
  }
}

/**
 * Report this host's sessions in the shape the badge needs.
 *
 * The payload is deliberately anonymous — `{ running, ageMs, pending? }` rows
 * with no session ids, titles, or content — because the reader is another
 * machine's browser, and counts are all the badge needs.
 *
 * Why `ageMs` (a DURATION) instead of an absolute `updatedAt`: the reader
 * compares "how long ago this session was touched" against "how long ago I last
 * looked", and both are durations, so the result never depends on the two
 * machines' clocks agreeing. Measured on this deployment, the peer's clock ran
 * ~3 s ahead of the reader's, which is more than enough to make a
 * just-before-you-looked update look like it arrived after you looked — the
 * exact bug that keeps a "new activity" dot from clearing.
 *
 * Subagent sessions are excluded: the sidebar shows them as descendants of
 * their parent, not as rows of their own, so counting them would inflate the
 * badge.
 *
 * `pending` (the amber "waiting for you" state) rides an optional field read
 * from the tracker that {@link observePendingInteractions} fills. It is
 * attributed to the session whose OWN request is open, plus — because a blocked
 * subagent blocks its parent's task — to that session's root ancestor, which is
 * the row a reader actually sees.
 * @param ctx - host context.
 * @param tracker - the peer's pending register, or undefined for a bare read.
 * @returns a status payload; never throws.
 */
export async function collectSelfStatus(ctx, tracker) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.list !== 'function') {
    return { version: STATUS_VERSION, available: false, reason: 'no-session-controller' }
  }
  let listed
  try {
    listed = await controller.list({}, AbortSignal.timeout(STATUS_TIMEOUT_MS))
  } catch (error) {
    return {
      version: STATUS_VERSION, available: false,
      reason: String(error?.message ?? error).slice(0, 200),
    }
  }
  const items = Array.isArray(listed?.items) ? listed.items : []

  // A pending request can be raised from a subagent, whose session is not a row
  // of its own, so the register is projected onto the top-level ancestor first.
  //
  // `sessionId` is the field `SessionSummary` actually carries (not `id`) — see
  // `packages/api/session-controller/src/types.ts`. It is the join key between
  // this list and the agent's `session.id` that the waterfalls hand us.
  const parentOf = new Map()
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.sessionId !== 'string') continue
    if (typeof item.parentSessionId === 'string' && item.parentSessionId !== '') {
      parentOf.set(item.sessionId, item.parentSessionId)
    }
  }
  const rootOf = (sessionId) => {
    let current = sessionId
    for (let hop = 0; hop < 64; hop += 1) {
      const parent = parentOf.get(current)
      if (parent === undefined) return current
      current = parent
    }
    return current
  }
  const pendingOf = new Map()
  if (tracker !== undefined && typeof tracker.entries === 'function') {
    for (const [sessionId, kind] of tracker.entries()) {
      const root = rootOf(sessionId)
      const shown = pendingOf.get(root)
      if (shown === undefined || PENDING_RANK[kind] > PENDING_RANK[shown]) pendingOf.set(root, kind)
    }
  }

  const now = Date.now()
  const sessions = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    if (item.blank === true) continue
    if (item.origin === 'subagent' || typeof item.parentSessionId === 'string') continue
    const updatedAt = Number(item.updatedAt) || 0
    const pending = typeof item.sessionId === 'string' ? pendingOf.get(item.sessionId) : undefined
    sessions.push({
      running: item.running === true,
      ageMs: updatedAt === 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, now - updatedAt),
      ...(pending === undefined ? {} : { pending }),
    })
    if (sessions.length >= STATUS_SESSION_CAP) break
  }
  return { version: STATUS_VERSION, available: true, sessions }
}

/**
 * Dispatch one local `/api/remote-dsh` request.
 * @param registry - the host registry.
 * @param request - incoming Node request.
 * @param response - Node response.
 * @param pathname - the request pathname.
 */
async function dispatch(registry, request, response, pathname) {
  const method = request.method ?? 'GET'
  const rest = pathname.slice(ROUTE_PREFIX.length)

  if (rest === '/hosts' && method === 'GET') {
    writeJson(response, 200, { hosts: registry.read() })
    return
  }

  if (rest === '/hosts' && method === 'POST') {
    const body = await readJsonBody(request)
    const hosts = registry.upsert(body)
    writeJson(response, 200, { hosts })
    return
  }

  if (rest.startsWith('/hosts/') && method === 'DELETE') {
    const id = decodeURIComponent(rest.slice('/hosts/'.length))
    writeJson(response, 200, { hosts: registry.remove(id) })
    return
  }

  if (rest === '/probe' && method === 'POST') {
    const body = await readJsonBody(request)
    const origin = normalizeOrigin(body.url)
    const result = await probeOrigin(origin)
    writeJson(response, 200, { url: origin, loopback: isLoopbackOrigin(origin), ...result })
    return
  }

  writeJson(response, 404, { error: `unknown route: ${method} ${pathname}` })
}

/**
 * Read the request pathname, or undefined when it cannot be parsed.
 * @param request - incoming Node request.
 * @returns the pathname.
 */
function requestPathname(request) {
  try {
    return new URL(request.url ?? '/', 'http://dsh.invalid').pathname
  } catch {
    return undefined
  }
}

/**
 * Build the local route this plugin claims on the web server.
 * @param registry - the host registry.
 * @returns one prefix route.
 */
export function makeRoute(registry) {
  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => {
      if (!isLoopbackRequest(request, false)) {
        writeJson(response, 403, { error: 'loopback only' })
        return
      }
      const pathname = requestPathname(request)
      if (pathname === undefined) {
        writeJson(response, 400, { error: 'malformed request URL' })
        return
      }
      dispatch(registry, request, response, pathname).catch(error => {
        writeJson(response, 400, { error: String(error?.message ?? error) })
      })
    },
  }
}

/**
 * Build the peer route: this host's own session state, nothing else.
 *
 * This is the one route that accepts a loopback Origin, so the local GUI can
 * read it cross-origin without CORS help from a Host proxy. See
 * {@link isLoopbackRequest}.
 * @param ctx - host context.
 * @param tracker - the peer's pending register, or undefined.
 * @returns one prefix route.
 */
export function makeSelfStatusRoute(ctx, tracker) {
  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (request, response) => {
      if (!isLoopbackRequest(request, true)) {
        writeJson(response, 403, { error: 'loopback only' })
        return
      }
      const pathname = requestPathname(request)
      if (pathname === undefined) {
        writeJson(response, 400, { error: 'malformed request URL' })
        return
      }
      const origin = request.headers.origin
      if (pathname !== SELF_STATUS_PATH) {
        writeJson(response, 404, { error: `unknown route: ${request.method ?? 'GET'} ${pathname}` }, origin)
        return
      }
      collectSelfStatus(ctx, tracker)
        .then(body => writeJson(response, 200, body, origin))
        .catch(error => writeJson(response, 500, { error: String(error?.message ?? error) }, origin))
    },
  }
}

/** Index marker that tells the browser half to stay inert on a peer host. */
const PEER_ROLE_MARKER = '<script>window.__DSH_REMOTE_DDH_ROLE__="peer"</script>'

/**
 * Inject the peer-role marker into every index render.
 *
 * Peer mode must not add a rail row: the peer's GUI is what a local instance
 * embeds, so a row there would nest the feature inside itself. Doing it through
 * an index injection keeps the browser half's decision synchronous — an async
 * role probe would flash the row before hiding it.
 * @param html - raw index body.
 * @returns the body carrying the marker.
 */
export function markPeerRole(html) {
  if (html.includes(PEER_ROLE_MARKER)) return html
  return html.includes('</head>')
    ? html.replace('</head>', `${PEER_ROLE_MARKER}</head>`)
    : `${PEER_ROLE_MARKER}${html}`
}

/**
 * Plugin body. `role: 'peer'` publishes this host's state; anything else runs
 * the full local surface.
 * @param ctx - host context.
 * @param config - row config (`{ role?: 'local' | 'peer' }`).
 */
export function apply(ctx, config) {
  const role = config !== null && typeof config === 'object' && config.role === 'peer' ? 'peer' : 'local'

  if (role === 'peer') {
    const pending = createPendingTracker()
    ctx.effect(
      () => observePendingInteractions(ctx, pending),
      'dsh-remote-dsh: pending-interaction observer',
    )
    ctx.effect(
      () => ctx.webServer.register(makeSelfStatusRoute(ctx, pending)),
      'dsh-remote-dsh: peer status route',
    )
    ctx.effect(() => ctx.webServer.tapIndex(markPeerRole), 'dsh-remote-dsh: peer role marker')
    return
  }

  const registry = new Registry(join(dshHome(), 'remote-dsh.json'))
  ctx.effect(() => ctx.webServer.register(makeRoute(registry)), 'dsh-remote-dsh: routes')
}

export {
  ROUTE_PREFIX, SELF_STATUS_PATH, STATUS_VERSION, normalizeOrigin, dshHome, PEER_ROLE_MARKER,
}
