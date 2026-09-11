/**
 * Client-half smoke test.
 *
 * Runs `lib/client.js` the way the browser's module system does — through a
 * stubbed `window.__ModuleLoader__` — then checks the exposed plugin contract,
 * drives `apply` against a fake `ctx.slots`, renders every registered component
 * with real React, and finally mounts the panel in jsdom to click the ⚙ toggle
 * for real.
 *
 * Not shipped (`files` in package.json omits this directory).
 *
 * Usage:
 *   npm install && npm test
 *
 * Developing inside a DSH checkout instead, pass its root to borrow the React,
 * react-dom, and jsdom already in the workspace store:
 *   node .verify/client-smoke.mjs /path/to/deepseek-harness
 */

const { createRequire } = await import('node:module')
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
const { existsSync, readdirSync } = await import('node:fs')

const checkout = process.argv[2] ?? process.env.DSH_CHECKOUT

/** First entry of a pnpm store directory matching a package prefix. */
function storeEntry(root, prefix) {
  const dir = join(root, 'node_modules/.pnpm')
  if (!existsSync(dir)) return undefined
  const hit = readdirSync(dir).find(name => name.startsWith(prefix))
  return hit === undefined ? undefined : join(dir, hit, 'node_modules')
}

/**
 * Resolve one dependency from either this repo's own install or, when a DSH
 * checkout was named, that checkout's pnpm store (pnpm does not hoist, so the
 * store needs an explicit hop).
 * @param spec - bare package specifier.
 * @param prefix - pnpm store directory prefix to try second.
 * @returns the absolute path of the resolved entry point.
 */
function resolveDep(spec, prefix) {
  try {
    return createRequire(join(process.cwd(), 'package.json')).resolve(spec)
  } catch (error) { /* fall through to the checkout store */ }
  const store = checkout === undefined ? undefined : storeEntry(checkout, prefix)
  if (store !== undefined) {
    try {
      return createRequire(join(store, 'package.json')).resolve(spec)
    } catch (error) { /* fall through to the message below */ }
  }
  console.error(
    `cannot resolve "${spec}".\n`
    + 'Run `npm install` here, or pass a DSH checkout root as the first argument'
    + ' (or via DSH_CHECKOUT) to borrow its pnpm store.',
  )
  process.exit(2)
}

const React = createRequire(resolveDep('react', 'react@'))('react')
const ReactDOMServer = createRequire(resolveDep('react-dom', 'react-dom@'))('react-dom/server')

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

// ── 1. Load the bundle through a stubbed loader facade ──────────────────────
const registrations = []
const fakeStorage = new Map()
globalThis.window = {
  __ModuleLoader__: { load: registration => registrations.push(registration) },
  // The status poller starts one interval in `apply`; a no-op keeps the module
  // loader stub sufficient. The store persists "last seen" stamps here.
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage: {
    getItem: key => (fakeStorage.has(key) ? fakeStorage.get(key) : null),
    setItem: (key, value) => { fakeStorage.set(key, String(value)) },
    removeItem: key => { fakeStorage.delete(key) },
  },
}

console.log('1. bundle registration')
await import(pathToFileURL(join(process.cwd(), 'lib/client.js')).href)
check('exactly one __ModuleLoader__.load call', registrations.length === 1, `got ${registrations.length}`)
const registration = registrations[0]
check('id is the package name', registration?.id === 'dsh-remote-dsh', String(registration?.id))
check('factory is a function', typeof registration?.factory === 'function')

// ── 2. Materialize exports with the platform-singleton require ──────────────
console.log('2. materialized exports')
const requireFromTable = spec => {
  if (spec === 'react') return React
  throw new Error(`unexpected require from the client bundle: ${spec}`)
}
const exported = registration.factory(requireFromTable)
check('exports.apply is a function', typeof exported.apply === 'function')
check('exports.inject is ["slots"]', JSON.stringify(exported.inject) === '["slots"]', JSON.stringify(exported.inject))
check('exports.RemoteWorkspace is a function', typeof exported.RemoteWorkspace === 'function')

// ── 3. apply() must claim the three official seats ──────────────────────────
console.log('3. slot registrations')
const injected = new Map()
const registered = []
const effects = []
const injectedStyles = []
let layoutSelection

// Minimal DOM: enough for the stylesheet installer, and it records what was
// injected so the selector can be asserted rather than assumed.
globalThis.document = {
  createElement(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      attributes: {},
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = value },
      remove() {
        const at = injectedStyles.indexOf(this)
        if (at !== -1) injectedStyles.splice(at, 1)
      },
    }
  },
  head: { appendChild(element) { injectedStyles.push(element) } },
}

const ctx = {
  slots: {
    inject(name, callback) {
      injected.set(name, callback)
      return () => {}
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
  get(name) {
    if (name !== 'layout') return undefined
    return { selectPanel: panelId => { layoutSelection = panelId } }
  },
  effect(callback, label) {
    const dispose = callback()
    effects.push({ label, dispose })
    return dispose
  },
}
exported.apply(ctx)

check('apply installs exactly two stylesheets (the sidebar seam, the dot chase)',
  injectedStyles.length === 2, String(injectedStyles.length))
const sidebarCss = injectedStyles[0]?.textContent ?? ''
check('stylesheet raises the panel list above New Session',
  sidebarCss.includes('[class*="panelList"]{order:-1}'), sidebarCss)
check('stylesheet keeps the brand row first',
  sidebarCss.includes('[class*="logoRow"]{order:-2}'), sidebarCss)
check('stylesheet is scoped to the sidebar anchor only',
  sidebarCss.split('}').filter(rule => rule !== '').every(rule => rule.startsWith('[data-slot="sidebar"]')), sidebarCss)
check('style tag is tagged for DOM inspection',
  injectedStyles[0]?.attributes['data-dsh-remote-dsh'] === 'sidebar-order')
check('the effect is labelled', effects.some(entry => String(entry.label).includes('styles')))

// The running dot animates through a keyframe, and React inline styles cannot
// carry one, so the rule has to ship in its own document-wide stylesheet.
const dotCss = injectedStyles[1]?.textContent ?? ''
check('the dot stylesheet is tagged separately from the sidebar rule',
  injectedStyles[1]?.attributes['data-dsh-remote-dsh'] === 'status-dot')
check('the dot stylesheet carries the chase keyframes',
  dotCss.includes('@keyframes dsh-remote-dsh-chase'), dotCss)
check('the chase holds four discrete brightness steps, as the sidebar does',
  dotCss.includes('0%,12.4%{opacity:1}') && dotCss.includes('12.5%,24.9%{opacity:.6}')
  && dotCss.includes('25%,37.4%{opacity:.35}') && dotCss.includes('37.5%,100%{opacity:.15}'), dotCss)
check('the animated class is namespaced, not a bare generic name',
  dotCss.includes('.dsh-remote-dsh-cell{'), dotCss)

check('injects sidebar.panellist', injected.has('sidebar.panellist'))
check('injects main (required for the rail pair check)', injected.has('main'))
check('injects shell.overlay (the takeover layer)', injected.has('shell.overlay'))
for (const callback of injected.values()) callback()

const rail = registered.find(row => row.options.name === 'sidebar.panellist')
const main = registered.find(row => row.options.name === 'main')
const overlay = registered.find(row => row.options.name === 'shell.overlay')
check('registered exactly three slots', registered.length === 3, `got ${registered.length}`)
check('rail row id is "remote-dsh"', rail?.options.id === 'remote-dsh', String(rail?.options.id))
check('rail row carries a label', typeof rail?.options.label === 'string' && rail.options.label !== '')
check('main key === rail id', main?.options.key === rail?.options.id,
  `key=${String(main?.options.key)} id=${String(rail?.options.id)}`)
check('overlay id === rail id', overlay?.options.id === rail?.options.id,
  `id=${String(overlay?.options.id)}`)

// ── 4. Render every component with real React ───────────────────────────────
console.log('4. React rendering')
const iconHtml = ReactDOMServer.renderToStaticMarkup(
  React.createElement(rail.component, { size: 16, active: true }),
)
check('rail icon renders an <svg>', iconHtml.startsWith('<svg'), iconHtml.slice(0, 60))
check('rail icon renders no text label', !/>[^<]*远程/u.test(iconHtml), iconHtml)
check('no session-state badge while nothing is known', !iconHtml.includes('data-dsh-remote-badge'), iconHtml.slice(0, 80))

// ── 4b. Session-state badge ─────────────────────────────────────────────────
console.log('')
console.log('4b. session-state badge')
const render = element => ReactDOMServer.renderToStaticMarkup(element)

check('statusBadge renders nothing for an all-zero aggregate',
  exported.statusBadge({ running: 0, unread: 0, unreachable: 0 }, false) === null)
check('statusBadge omits the unreachable row when the local route failed (-1)',
  exported.statusBadge({ running: 0, unread: 0, unreachable: -1 }, false) === null)

const wide = render(exported.statusBadge({ running: 1, unread: 2, unreachable: 0 }, false))
check('wide badge shows a count per state', wide.includes('>1<') && wide.includes('>2<'), wide)
check('wide badge uses the running token for the blue dot', wide.includes('--dsw-static-deepseek-450'), wide)
check('wide badge uses the success token for the green dot', wide.includes('--dsw-alias-state-success-primary'), wide)
check('the green count is labelled as activity, not as idle sessions',
  wide.includes('上次查看后有活动'), wide)

const compact = render(exported.statusBadge({ running: 1, unread: 2, unreachable: 0 }, true))
check('rail badge drops the counts',
  !compact.includes('>1<') && !compact.includes('>2<'), compact)
check('rail badge takes the running color when anything is running',
  compact.includes('--dsw-static-deepseek-450'), compact)
// "Running" is the one state that animates, and it must be the sidebar's own
// eight-cell chase rather than a second, lookalike spinner.
check('rail badge animates the running state with the sidebar chase',
  compact.startsWith('<svg') && compact.includes('shape-rendering="crispEdges"'), compact.slice(0, 120))
check('the chase draws the eight outer cells clockwise from the top-left',
  (compact.match(/<rect /gu) ?? []).length === 8
  && compact.includes('x="0" y="0"') && compact.includes('x="8" y="8"'), compact.slice(0, 200))
check('every cell is phased a step apart so the chase runs from mount',
  compact.includes('animation-delay:-1000ms') && compact.includes('animation-delay:-125ms'), compact.slice(-260))
check('every cell carries the namespaced animation class',
  (compact.match(/class="dsh-remote-dsh-cell"/gu) ?? []).length === 8)
const compactUnread = render(exported.statusBadge({ running: 0, unread: 3, unreachable: 0 }, true))
check('rail badge falls back to the done color when there is unread activity',
  compactUnread.includes('--dsw-alias-state-success-primary'), compactUnread)
// Only "running" animates: a still dot is a halo plus a 6/10-scale core.
check('a non-running state is a still halo-plus-core dot, not the chase',
  compactUnread.includes('border-radius:50%') && !compactUnread.includes('<svg'), compactUnread)
check('the still dot is layered the way the sidebar draws it',
  (compactUnread.match(/border-radius:50%/gu) ?? []).length === 2
  && compactUnread.includes('opacity:0.1'), compactUnread)

// The unread verdict must be a DURATION comparison only. This deployment's peer
// clock runs ~3 s ahead, which an absolute-timestamp comparison would turn into
// "activity arrived after you looked" for updates that landed just before.
check('activity newer than the last look counts as unread',
  exported.isUnreadSession({ running: false, ageMs: 1000 }, 5000) === true)
check('activity older than the last look counts as seen',
  exported.isUnreadSession({ running: false, ageMs: 9000 }, 5000) === false)
check('viewing right now (elapsed 0) makes everything seen',
  exported.isUnreadSession({ running: false, ageMs: 0 }, 0) === false)
check('a running session is never counted as unread',
  exported.isUnreadSession({ running: true, ageMs: 1 }, 5000) === false)
check('the peer payload carries a duration, not a timestamp',
  exported.isUnreadSession({ running: false, ageMs: 1 }, 5000) === true
  && exported.isUnreadSession({ running: false, updatedAt: 1 }, 5000) === false)

// ── 4d. One session, one unread ─────────────────────────────────────────────
// Reported: a remote session finished and the green dot showed **2**. The reader
// used to add its own completion count to the per-session prompt count, so a
// session that was prompted and then finished scored twice — and the clamp that
// was supposed to absorb that only bounded the total by the peer's session
// count, which on a two-session peer is exactly the wrong number.
//
// The fix is structural: `completedAgeMs` rides the SAME row as `ageMs`, and a
// row is unread or not. Two signals on one session cannot add up to two.
console.log('')
console.log('4d. one session, one unread')

check('a finish reported on the row makes it unread',
  exported.isUnreadSession({ running: false, ageMs: 600000, completedAgeMs: 1000 }, 30000) === true)
check('...even though the prompt age alone predates the last look',
  exported.isUnreadSession({ running: false, ageMs: 600000 }, 30000) === false)
check('a prompt and a finish on ONE session is still one session',
  exported.isUnreadSession({ running: false, ageMs: 500, completedAgeMs: 1000 }, 30000) === true
  && exported.activityAgeMs({ running: false, ageMs: 500, completedAgeMs: 1000 }) === 500)
check('the smaller of the two durations is the one reported',
  exported.activityAgeMs({ ageMs: 9000, completedAgeMs: 100 }) === 100
  && exported.activityAgeMs({ ageMs: 100, completedAgeMs: 9000 }) === 100)
check('a row with only the older durations is not unread',
  exported.isUnreadSession({ running: false, ageMs: 900000, completedAgeMs: 800000 }, 30000) === false)
check('a row with no durations at all is not unread',
  exported.isUnreadSession({ running: false }, 30000) === false
  && exported.activityAgeMs({ running: false }) === Infinity)
check('a peer older than v5 still reports prompt activity',
  exported.isUnreadSession({ running: false, ageMs: 1000 }, 30000) === true)

// End to end through readPeer: a v5 peer with one finished session must report
// ONE unread session, not two, no matter how the prompt and finish line up.
let peerBody = { version: 5, available: true, sessions: [] }
globalThis.fetch = async () => ({ ok: true, json: async () => peerBody })
const peerRow = { id: 'h9', name: 'mengshan', url: 'http://127.0.0.1:3099' }

peerBody = {
  version: 5, available: true,
  sessions: [{ running: false, ageMs: 400000, completedAgeMs: 2000 }, { running: false, ageMs: 900000 }],
}
const reported = await exported.readPeer(peerRow, 30000)
check('a host with one finished session reports one unread session',
  reported.unread === 1, JSON.stringify(reported))

peerBody = {
  version: 5, available: true,
  sessions: [{ running: false, ageMs: 400000, completedAgeMs: 2000 }, { running: true, ageMs: 100, completedAgeMs: 5 }],
}
const whileRunning = await exported.readPeer(peerRow, 30000)
check('a running session is counted as running even after a previous finish',
  whileRunning.running === 1 && whileRunning.unread === 1, JSON.stringify(whileRunning))

peerBody = {
  version: 5, available: true,
  sessions: [{ running: false, ageMs: 1000 }, { running: false, ageMs: 2000 }],
}
const twoIdle = await exported.readPeer(peerRow, 5000)
check('a session prompted while you were away is unread on its own',
  twoIdle.unread === 2 && twoIdle.running === 0, JSON.stringify(twoIdle))

// A v4 peer has no completion field; it must not be mistaken for one.
peerBody = { version: 4, available: true, sessions: [{ running: false, ageMs: 400000 }] }
const legacy = await exported.readPeer(peerRow, 30000)
check('a v4 peer reports no completion it cannot know about',
  legacy.unread === 0 && legacy.peer === true, JSON.stringify(legacy))

// ── 4c. The amber "waiting for you" state ───────────────────────────────────
// A peer session blocked on an approval, a question, or a plan review is the
// one state the operator must not miss, so it outranks every other color.
console.log('')
console.log('4c. waiting-for-you state')

check('every pending kind the remote can report is recognised',
  ["approval", "question", "plan-review"].every(kind => exported.isWaitingOnUser({ pending: kind })))
check('a session with no pending field is not waiting (v3 peers never send one)',
  exported.isWaitingOnUser({ running: true, ageMs: 5 }) === false)
check('an unknown pending kind is ignored rather than trusted',
  exported.isWaitingOnUser({ pending: "something-else" }) === false)
check('a malformed session row is not waiting',
  exported.isWaitingOnUser(null) === false && exported.isWaitingOnUser("approval") === false)

const waitingWide = render(exported.statusBadge({ waiting: 1, running: 2, unread: 3, unreachable: 0 }, false))
check('wide badge shows a count for the waiting state', waitingWide.includes('>1<'), waitingWide)
check('wide badge uses the amber token for the waiting dot',
  waitingWide.includes('--dsw-alias-state-warn-primary'), waitingWide)
check('the waiting count is labelled as a request to the operator',
  waitingWide.includes('等待你回答'), waitingWide)
check('waiting is rendered before running in the wide badge',
  waitingWide.indexOf('等待你回答') < waitingWide.indexOf('运行中'), waitingWide)

const waitingCompact = render(exported.statusBadge({ waiting: 1, running: 2, unread: 3, unreachable: 0 }, true))
check('rail badge takes the amber color when a session is waiting for you',
  waitingCompact.includes('--dsw-alias-state-warn-primary'), waitingCompact)
check('...as a still dot: waiting is an alarm, not an ongoing chase',
  !waitingCompact.includes('<svg') && waitingCompact.includes('border-radius:50%'), waitingCompact)
// The wide row pairs each state with its count, so the running one has to keep
// the chase there too.
check('wide badge animates its running dot as well',
  (wide.match(/<svg [^>]*crispEdges/gu) ?? []).length === 1, wide)
check('wide badge animates only its running dot, never the still states',
  (waitingWide.match(/<svg [^>]*crispEdges/gu) ?? []).length === 1, waitingWide.slice(0, 120))
check('...and the amber waiting dot stays a still halo-plus-core dot',
  waitingWide.includes('--dsw-alias-state-warn-primary')
  && (waitingWide.match(/border-radius:50%/gu) ?? []).length === 4, waitingWide)
const amberOverRed = render(exported.statusBadge({ waiting: 1, running: 0, unread: 0, unreachable: 4 }, true))
check('rail badge prefers amber over the unreachable color',
  amberOverRed.includes('--dsw-alias-state-warn-primary') && !amberOverRed.includes('--dsw-alias-state-error-primary'),
  amberOverRed)
check('a waiting count of zero renders no badge at all',
  exported.statusBadge({ waiting: 0, running: 0, unread: 0, unreachable: 0 }, false) === null)

const waitingTip = exported.statusTooltip(
  { waiting: 1, running: 0, unread: 0, unreachable: 0 },
  [{ id: 'h1', name: 'mengshan', reachable: true, peer: true, waiting: 1, running: 0, unread: 0 }],
)
check('the tooltip names the waiting state and its per-host breakdown',
  waitingTip.includes('等待你回答 1') && waitingTip.includes('mengshan：1 等待 / 0 运行 / 0 有活动'), waitingTip)
check('an idle remote still reports no new activity',
  exported.statusTooltip({ waiting: 0, running: 0, unread: 0, unreachable: 0 }, []) === '远程 · 无新活动')

// Driving the real store proves the glyph is wired to it, not just that the
// badge function renders.
exported.statusStore.set({
  totals: { waiting: 1, running: 1, unread: 2, unreachable: 0 },
  hosts: [{
    id: 'h1', name: 'mengshan', reachable: true, peer: true, waiting: 1, running: 1, unread: 2,
  }],
  failed: false,
})
const badgeHtml = render(React.createElement(rail.component, { size: 16, active: true }))
check('the rail glyph subscribes to the store', badgeHtml.includes('data-dsh-remote-badge'), badgeHtml.slice(0, 100))
check('the glyph tooltip breaks the aggregate down per host',
  badgeHtml.includes('mengshan') && badgeHtml.includes('运行中 1'), badgeHtml)
check('the glyph carries the waiting state into the rail',
  badgeHtml.includes('等待你回答') && badgeHtml.includes('--dsw-alias-state-warn-primary'), badgeHtml)

// The regression the user hit: an "idle session" badge could never clear.
// Opening a host's view must drop its unread count on the spot, and leave the
// running count alone.
exported.statusStore.setViewing('h1')
const seenHtml = render(React.createElement(rail.component, { size: 16, active: true }))
check('opening a host view clears its unread count immediately',
  !seenHtml.includes('上次查看后有活动'), seenHtml)
check('...without disturbing the running count',
  seenHtml.includes('运行中') && seenHtml.includes('>1<'), seenHtml)
// Waiting is a live condition, not a notification: looking at the remote does
// not answer the question, so the amber dot must survive the visit.
check('...and without pretending a waiting session was answered',
  seenHtml.includes('等待你回答'), seenHtml)
check('a host that was just viewed is recorded as seen',
  Number(globalThis.window.localStorage.getItem('dsh-remote-dsh:last-seen:h1')) > 0)

exported.statusStore.setViewing(null)
exported.statusStore.set({ totals: { waiting: 0, running: 0, unread: 0, unreachable: 0 }, hosts: [], failed: false })
const clearedHtml = render(React.createElement(rail.component, { size: 16, active: true }))
check('clearing the store removes the badge again', !clearedHtml.includes('data-dsh-remote-badge'))

const mainHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(main.component, {}))
check('main placeholder renders nothing', mainHtml === '', mainHtml)

const panelInfo = activePanelId => selector => selector({ activePanelId })
let exited = 0
const onExit = () => { exited += 1 }

const inactiveHtml = ReactDOMServer.renderToStaticMarkup(
  React.createElement(exported.RemoteWorkspace, { usePanelInfo: panelInfo(null), onExit }),
)
check('workspace stays MOUNTED while the rail row is not selected',
  inactiveHtml.includes('data-dsh-remote-workspace'), inactiveHtml.slice(0, 120))
check('...but is hidden with display:none (that is what keeps the iframe alive)',
  /data-dsh-remote-workspace="[^"]*"[^>]*display:none/u.test(inactiveHtml))
check('hidden workspace is not marked active', !inactiveHtml.includes('data-active="true"'))

let activeHtml
try {
  activeHtml = ReactDOMServer.renderToStaticMarkup(
    React.createElement(exported.RemoteWorkspace, { usePanelInfo: panelInfo('remote-dsh'), onExit }),
  )
  check('workspace renders when selected', true)
} catch (error) {
  check('workspace renders when selected', false, String(error && error.message))
}
if (activeHtml !== undefined) {
  check('takeover covers the whole frame (absolute inset 0)',
    activeHtml.includes('position:absolute') && activeHtml.includes('inset:0'))
  check('visible workspace switches to display:flex',
    /data-dsh-remote-workspace="[^"]*"[^>]*display:flex/u.test(activeHtml))
  check('visible workspace is marked active', activeHtml.includes('data-active="true"'))
  check('bar keeps the way back', activeHtml.includes('返回本地 DSH'))
  check('bar keeps the add action', activeHtml.includes('＋ 添加'))
  check('bar keeps a settings toggle', activeHtml.includes('⚙'))
  check('bar renders a short status label, not the whole sentence',
    activeHtml.includes('未探测') && !activeHtml.includes('尚未探测该主机。</span>'))
  check('settings stay collapsed (no token field) while nothing needs pairing',
    !activeHtml.includes('粘贴远程 dsh web 打印的 token'))
  check('no iframe is created before a host exists', !activeHtml.includes('<iframe'))
  check('empty state shown with no hosts', activeHtml.includes('还没有配置远程 DSH'))
  check('takeover is flagged for DOM inspection', activeHtml.includes('data-dsh-remote-workspace'))
}

console.log('')
console.log('5. teardown')
for (const effect of effects) {
  if (typeof effect.dispose === 'function') effect.dispose()
}
check('disposing the fiber removes the injected stylesheet', injectedStyles.length === 0, String(injectedStyles.length))

// ── 6. Real interaction: render into jsdom and click the gear ───────────────
// A structural render cannot catch "a derived condition overrides the toggle",
// which is the bug this section exists to prevent. The host below is UNPAIRED,
// the state that used to force the settings row open and wedge ⚙.
console.log('')
console.log('6. interaction (jsdom): the ⚙ toggle is authoritative')

const { JSDOM } = createRequire(resolveDep('jsdom', 'jsdom@'))('jsdom')
const ReactDOMClient = createRequire(resolveDep('react-dom', 'react-dom@'))('react-dom/client')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.IS_REACT_ACT_ENVIRONMENT = false
try {
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
} catch (error) { /* Node's own read-only navigator is good enough */ }

const HOST = { id: 'host-1', name: 'mengshan', url: 'http://127.0.0.1:3081' }
globalThis.fetch = async (url, init) => {
  const method = (init && init.method) || 'GET'
  const body = String(url).endsWith('/hosts') && method === 'GET'
    ? { hosts: [HOST] }
    : { url: HOST.url, loopback: true, reachable: true, status: 401, dshAuthRequired: true, elapsedMs: 1 }
  return { ok: true, status: 200, json: async () => body }
}

const tick = async (ms = 40) => { await new Promise(resolve => { dom.window.setTimeout(resolve, ms) }) }

const container = dom.window.document.getElementById('app')
const root = ReactDOMClient.createRoot(container)
root.render(React.createElement(exported.RemoteWorkspace, {
  usePanelInfo: selector => selector({ activePanelId: 'remote-dsh' }),
  onExit: () => {},
}))
await tick()

const tokenField = () => Array.from(container.querySelectorAll('input'))
  .find(input => String(input.placeholder).includes('token'))
const gear = () => Array.from(container.querySelectorAll('button'))
  .find(button => button.textContent === '⚙')

check('the host list loaded and the remote frame is mounted', container.querySelector('iframe') !== null)
check('an UNPAIRED host does not force the settings row open', tokenField() === undefined)
check('the ⚙ toggle is present', gear() !== undefined)

gear()?.click()
await tick()
check('clicking ⚙ opens the settings row', tokenField() !== undefined)
check('the ⚙ tooltip reads 收起设置', gear()?.getAttribute('title') === '收起设置')

gear()?.click()
await tick()
check('clicking ⚙ again collapses it (the reported regression)', tokenField() === undefined)
check('the ⚙ tooltip reads 展开设置 again', String(gear()?.getAttribute('title')).startsWith('展开设置'))

root.unmount()

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('all client-half checks passed')
