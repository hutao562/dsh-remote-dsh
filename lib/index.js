/**
 * dsh-remote-dsh — Node half.
 *
 * Runs inside a DSH host process. Which half of the feature it owns depends on
 * the row's `role` config:
 *
 *  - `local` (default): the remote-host registry (`$DSH_HOME/remote-dsh.json`)
 *    plus the `/api/remote-dsh` route family — hosts CRUD and a liveness probe.
 *  - `peer`: this host publishes its OWN session state on a loopback route, and
 *    suppresses the browser half through an index injection.
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

/** State-payload contract version; a reader ignores a peer that reports another. */
const STATUS_VERSION = 3

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

/**
 * Report this host's sessions in the shape the badge needs.
 *
 * The payload is deliberately anonymous — `{ running, ageMs }` rows with no
 * session ids, titles, or content — because the reader is another machine's
 * browser, and counts are all the badge needs.
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
 * `warning` (waiting for the operator) is deliberately absent: pending
 * interactions are assembled in the BROWSER from the pending domains the
 * approval and question packages register, and no Host service exposes them.
 * @param ctx - host context.
 * @returns a status payload; never throws.
 */
export async function collectSelfStatus(ctx) {
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
  const now = Date.now()
  const sessions = []
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue
    if (item.blank === true) continue
    if (item.origin === 'subagent' || typeof item.parentSessionId === 'string') continue
    const updatedAt = Number(item.updatedAt) || 0
    sessions.push({
      running: item.running === true,
      ageMs: updatedAt === 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, now - updatedAt),
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
 * @returns one prefix route.
 */
export function makeSelfStatusRoute(ctx) {
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
      collectSelfStatus(ctx)
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
    ctx.effect(() => ctx.webServer.register(makeSelfStatusRoute(ctx)), 'dsh-remote-dsh: peer status route')
    ctx.effect(() => ctx.webServer.tapIndex(markPeerRole), 'dsh-remote-dsh: peer role marker')
    return
  }

  const registry = new Registry(join(dshHome(), 'remote-dsh.json'))
  ctx.effect(() => ctx.webServer.register(makeRoute(registry)), 'dsh-remote-dsh: routes')
}

export { ROUTE_PREFIX, SELF_STATUS_PATH, STATUS_VERSION, normalizeOrigin, dshHome, PEER_ROLE_MARKER }
