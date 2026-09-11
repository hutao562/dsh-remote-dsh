/**
 * Host-half test for the pending-interaction report.
 *
 * The amber "this session is waiting for you" state has no Host service behind
 * it: the browser builds it from pending domains that `ui-approval` and
 * `ui-user-questions` register. The ONLY Host-visible fact is that a
 * scope-filtered waterfall is still open, so this file drives those two
 * waterfalls by hand and checks that the tracker follows them exactly —
 * including the paths that must release it (resolve, reject, sync throw) and the
 * paths that must not (an event carrying no agent).
 *
 * It then checks that the peer status payload attributes each open request to
 * the row a reader actually sees, which means walking a subagent's request up to
 * its top-level ancestor.
 *
 * Not shipped (`files` in package.json omits this directory).
 *
 * Usage:
 *   npm run test:host
 */

const { createPendingTracker, observePendingInteractions, collectSelfStatus, STATUS_VERSION } =
  await import('../lib/index.js')

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${detail}`}`)
  }
}

/** A context exposing only the listener registry `observePendingInteractions` uses. */
function fakeCtx() {
  const listeners = new Map()
  return {
    listeners,
    on(name, listener) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(listener)
      return () => {
        const list = listeners.get(name)
        const at = list.indexOf(listener)
        if (at !== -1) list.splice(at, 1)
        if (list.length === 0) listeners.delete(name)
      }
    },
    /** Dispatch one scoped waterfall exactly as the Host does. */
    waterfall(name, request, fallback) {
      const chain = listeners.get(name) ?? []
      let index = -1
      const next = () => {
        index += 1
        const listener = chain[index]
        if (listener === undefined) return Promise.resolve(fallback())
        // Cordis binds the scope carrier as `this`; an unrelated object proves
        // the observer never depends on it.
        return listener.call({ scope: true }, request, next)
      }
      return next()
    },
  }
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// ── 1. The register itself ──────────────────────────────────────────────────
console.log('1. pending register')
const tracker = createPendingTracker()
check('an untouched register reports nothing', tracker.entries().length === 0)
const releaseApproval = tracker.track('s1', 'approval')
check('a tracked request is visible', tracker.kindOf('s1') === 'approval')
const releaseReview = tracker.track('s1', 'plan-review')
check('the highest-ranked open kind wins (plan review over approval)',
  tracker.kindOf('s1') === 'plan-review')
const releaseQuestion = tracker.track('s1', 'question')
check('...and a question still outranks an approval',
  tracker.kindOf('s1') === 'plan-review', tracker.kindOf('s1'))
releaseReview()
check('releasing the top kind falls back to the next one', tracker.kindOf('s1') === 'question')
releaseApproval()
check('releasing one of two keeps the session open', tracker.kindOf('s1') === 'question')
releaseQuestion()
check('releasing the last request clears the session', tracker.kindOf('s1') === undefined)
check('the cleared session is gone from the report', tracker.entries().length === 0)
releaseQuestion()
check('release is idempotent', tracker.kindOf('s1') === undefined)
tracker.track('s2', 'approval')
check('sessions are reported independently',
  JSON.stringify(tracker.entries()) === '[["s2","approval"]]', JSON.stringify(tracker.entries()))

// ── 2. Driving the two waterfalls ───────────────────────────────────────────
console.log('')
console.log('2. waterfall observers')
const ctx = fakeCtx()
const live = createPendingTracker()
const dispose = observePendingInteractions(ctx, live)
check('both pending waterfalls are observed',
  ctx.listeners.has('approval/request') && ctx.listeners.has('user-questions/request'))

const held = deferred()
const approvalOutcome = ctx.waterfall(
  'approval/request', { agent: { session: { id: 'root' } }, toolName: 'pwsh' },
  () => held.promise,
)
check('an open approval marks its session as waiting', live.kindOf('root') === 'approval')
held.resolve('allowed-once')
check('a granted approval passes its outcome through', (await approvalOutcome) === 'allowed-once')
check('...and clears the session', live.kindOf('root') === undefined)

const rejected = deferred()
const rejecting = ctx.waterfall(
  'approval/request', { agent: { session: { id: 'root' } } }, () => rejected.promise,
)
check('a second approval re-marks the session', live.kindOf('root') === 'approval')
rejected.reject(new Error('answerer exploded'))
check('a rejected chain still clears the session',
  await rejecting.then(() => false, () => true) && live.kindOf('root') === undefined)

// A listener later in the chain may throw before its first await, and the
// approval service contains exactly that case. The observer must not change it:
// the throw still surfaces synchronously, and the register is still released.
let syncThrow
try {
  ctx.waterfall(
    'approval/request', { agent: { session: { id: 'root' } } },
    () => { throw new Error('sync answerer') },
  )
} catch (error) {
  syncThrow = error
}
check('a synchronous throw propagates synchronously, exactly as without the observer',
  syncThrow?.message === 'sync answerer', String(syncThrow?.message))
check('...and still clears the session', live.kindOf('root') === undefined)

const agentless = ctx.waterfall('approval/request', {}, () => Promise.resolve('unavailable'))
check('a request with no agent is passed through untouched', (await agentless) === 'unavailable')
check('...and is never tracked', live.entries().length === 0)

const plain = deferred()
const questionOutcome = ctx.waterfall(
  'user-questions/request',
  { agent: { session: { id: 'root' } }, questions: [{ id: 'q1', question: 'pick one' }] },
  () => plain.promise,
)
check('a plain question is tracked as a question', live.kindOf('root') === 'question')
plain.resolve({ answers: [] })
await questionOutcome

const plan = deferred()
const planOutcome = ctx.waterfall(
  'user-questions/request',
  {
    agent: { session: { id: 'root' } },
    questions: [{ id: 'q1', question: 'approve?', intent: { kind: 'plan-review', approve: 'yes' } }],
  },
  () => plan.promise,
)
check('a question tagged plan-review is tracked as one', live.kindOf('root') === 'plan-review')
plan.resolve({ answers: [] })
await planOutcome

dispose()
check('disposing removes both listeners',
  !ctx.listeners.has('approval/request') && !ctx.listeners.has('user-questions/request'))

// ── 3. What the peer publishes ──────────────────────────────────────────────
//
// The rows below mirror `SessionSummary` from
// `packages/api/session-controller/src/types.ts` field for field, including the
// fact that the identity field is `sessionId` and NOT `id`. Getting that name
// wrong is silent: the register fills, the join finds nothing, and the payload
// simply never carries `pending`.
console.log('')
console.log('3. self-status payload')
const now = Date.now()
const items = [
  { sessionId: 'root', running: true, blank: false, updatedAt: now - 1000 },
  { sessionId: 'blank', blank: true, running: false, updatedAt: now - 2000 },
  { sessionId: 'child', origin: 'subagent', parentSessionId: 'root', blank: false, running: true, updatedAt: now - 500 },
  { sessionId: 'other', blank: false, running: false, updatedAt: now - 60000 },
]
const statusCtx = { get: name => (name === 'sessionController'
  ? { list: async () => ({ items }) }
  : undefined) }

const bare = await collectSelfStatus(statusCtx)
check('the payload reports the current contract version', bare.version === STATUS_VERSION, String(bare.version))
check('subagent and blank sessions are not rows of their own',
  bare.sessions.length === 2, JSON.stringify(bare.sessions))
check('a bare read carries no pending field at all',
  bare.sessions.every(session => !('pending' in session)), JSON.stringify(bare.sessions))

const attributed = createPendingTracker()
attributed.track('root', 'approval')
const own = await collectSelfStatus(statusCtx, attributed)
check('a session waiting for the operator is reported as pending',
  own.sessions.find(session => session.running === true)?.pending === 'approval',
  JSON.stringify(own.sessions))
check('a session with nothing open carries no pending field',
  !('pending' in own.sessions.find(session => session.ageMs > 50000)), JSON.stringify(own.sessions))

const fromChild = createPendingTracker()
fromChild.track('child', 'question')
const rolled = await collectSelfStatus(statusCtx, fromChild)
check('a blocked subagent is attributed to the row the reader sees',
  rolled.sessions.find(session => session.running === true)?.pending === 'question',
  JSON.stringify(rolled.sessions))

const orphan = createPendingTracker()
orphan.track('never-listed', 'approval')
const unlisted = await collectSelfStatus(statusCtx, orphan)
check('a request from a session that is not listed changes nothing',
  unlisted.sessions.every(session => !('pending' in session)), JSON.stringify(unlisted.sessions))

// Pin the join key itself: `id` is the wrong name, and a row that carries only
// `id` must be treated as carrying no identity at all.
const wrongKey = createPendingTracker()
wrongKey.track('legacy', 'approval')
const misnamed = await collectSelfStatus(
  { get: name => (name === 'sessionController'
    ? { list: async () => ({ items: [{ id: 'legacy', blank: false, running: true, updatedAt: now }] }) }
    : undefined) },
  wrongKey,
)
check('a summary exposing only `id` is not silently joined (the field is `sessionId`)',
  misnamed.sessions.length === 1 && !('pending' in misnamed.sessions[0]),
  JSON.stringify(misnamed.sessions))

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} host-half check(s) failed:`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
console.log('all host-half checks passed')
