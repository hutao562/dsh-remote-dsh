/**
 * dsh-remote-dsh — browser half.
 *
 * Hand-authored bundle in the client module system's wrapper format
 * (`window.__ModuleLoader__.load({ id, factory })`); the loader materializes
 * the factory and activates the returned exports as an ordinary Cordis plugin.
 * The package deliberately has no build step, so this file is the source.
 *
 * Three official extension seats carry the feature — no DOM scraping:
 *
 *  - `sidebar.panellist` (root list) contributes the rail row and its label.
 *    The shell owns the button, the tooltip, and the accessible name, and
 *    renders the row near the top of the column, between "New Session" and the
 *    session list.
 *  - `main` (root keyed) must exist under the SAME id or ui-layout refuses the
 *    selection ("selecting a missing main entry throws"), so this registration
 *    is what makes the rail row selectable. It renders nothing: the visible
 *    surface is the overlay below.
 *  - `shell.overlay` (root list) draws the takeover. Its layer is
 *    `position: absolute; inset: 0` inside the app frame, so one element there
 *    covers the entire page — sidebar included — which is the point: clicking
 *    the rail row makes the whole page the remote DSH, not a panel beside the
 *    conversation.
 *
 * The overlay stays MOUNTED while another panel is selected and is hidden with
 * `display: none` instead of unmounting. Removing an iframe from the document
 * destroys its browsing context and reloads the remote SPA on the way back;
 * `display: none` keeps the document, its session, and its scroll position
 * alive, so returning to the remote view is instant.
 *
 * The overlay embeds the remote DSH in an iframe. That only works when the
 * remote is same-site with this page: its session cookie is `HttpOnly;
 * SameSite=Strict`, so a remote reached at a public domain is cross-site, its
 * cookie is withheld, and its own index.html answers 401. A loopback port
 * forward (frpc stcp/xtcp visitor, `ssh -L`, …) satisfies this, because
 * SameSite ignores the port.
 */

window.__ModuleLoader__.load({ id: "dsh-remote-dsh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";

var React = require("react");
var h = React.createElement;

/** Same-origin route family owned by this plugin's Node half. */
var API = "/api/remote-dsh";

/** The list id, the `main` key, and the overlay row id all share this value. */
var PANEL_ID = "remote-dsh";

/** localStorage key remembering the last selected host. */
var ACTIVE_KEY = "dsh-remote-dsh:active";

/** localStorage key prefix marking a host whose token was already submitted. */
var PAIRED_KEY = "dsh-remote-dsh:paired:";

/** Probe cadence for the selected host, in milliseconds. */
var PROBE_INTERVAL_MS = 10000;

/** Palette entries resolved from the shipped theme tokens, each with a literal fallback. */
var COLOR = {
  text: "var(--dsw-alias-label-primary, #e6e6e6)",
  dim: "var(--dsw-alias-label-caption, rgba(150,150,160,.95))",
  faint: "var(--dsw-alias-label-dimmed, rgba(140,140,150,.75))",
  border: "var(--dsw-alias-border-l2, rgba(128,128,140,.22))",
  panel: "var(--dsw-alias-bg-base, #101014)",
  raised: "var(--dsw-alias-bg-layer-1, rgba(128,128,140,.08))",
  chrome: "var(--dsw-alias-bg-layer-2, rgba(128,128,140,.12))",
  accent: "var(--dsw-alias-button-primary-fill, #4d6bfe)",
  ok: "#3ecf8e",
  warn: "#e0a340",
  bad: "#e07171",
  // Session-state colors, read from the SAME tokens the sidebar's own StateDot
  // uses, so the badge matches the remote's session list exactly.
  running: "var(--dsw-static-deepseek-450, #4d6bfe)",
  done: "var(--dsw-alias-state-success-primary, #3ecf8e)",
  attention: "var(--dsw-alias-state-warn-primary, #e0a340)",
  failure: "var(--dsw-alias-state-error-primary, #e07171)",
};

/** Cadence for reading the aggregate remote session state, in milliseconds. */
var STATUS_POLL_MS = 15000;

/** The empty snapshot; also the server snapshot, so SSR does not throw. */
var EMPTY_TOTALS = { waiting: 0, running: 0, unread: 0, unreachable: 0 };

/** localStorage key prefix recording when a host's peer view was last open. */
var LAST_SEEN_KEY = "dsh-remote-dsh:last-seen:";

/**
 * When this browser last had a host's remote view open.
 *
 * "Idle" is a permanent property, so a badge that counted idle sessions could
 * never clear. Comparing each session's `updatedAt` against this timestamp is
 * what makes the green dot mean "activity since you last looked" instead.
 * @param hostId - registry row id.
 * @returns epoch milliseconds, or 0 when never seen.
 */
function readLastSeen(hostId) {
  try { return Number(window.localStorage.getItem(LAST_SEEN_KEY + hostId)) || 0; } catch (error) { return 0; }
}

/** Record that a host's remote view is being looked at now. */
function writeLastSeen(hostId, at) {
  try { window.localStorage.setItem(LAST_SEEN_KEY + hostId, String(at)); } catch (error) { /* private mode */ }
}

/** Host whose remote view is open right now, or null. Read by the poller. */
var viewingHostId = null;

/**
 * Shared session-state store.
 *
 * The rail icon and the overlay are separate slot components, so the data lives
 * in one module-level store that both read through `useSyncExternalStore`, while
 * `apply` owns the polling lifetime.
 * @returns a minimal external store.
 */
function createStatusStore() {
  var snapshot = { totals: EMPTY_TOTALS, hosts: [], failed: true };
  var listeners = [];
  var notify = function () { listeners.slice().forEach(function (listener) { listener() }) };
  var totalsOf = function (hosts) {
    var totals = { waiting: 0, running: 0, unread: 0, unreachable: 0 };
    hosts.forEach(function (row) {
      if (row.reachable === true && row.peer === true) {
        totals.waiting += row.waiting || 0;
        totals.running += row.running || 0;
        totals.unread += row.unread || 0;
      } else {
        totals.unreachable += 1;
      }
    });
    return totals;
  };
  return {
    getSnapshot: function () { return snapshot },
    subscribe: function (listener) {
      listeners.push(listener);
      return function () {
        var at = listeners.indexOf(listener);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    set: function (next) {
      snapshot = next;
      notify();
    },
    totalsOf: totalsOf,
    /**
     * Declare which host's remote view is open. Opening one marks its current
     * activity as seen immediately, so the dot clears on the spot instead of
     * waiting for the next poll.
     * @param hostId - the viewed host, or null when the view is closed.
     */
    setViewing: function (hostId) {
      viewingHostId = hostId;
      if (hostId === null || hostId === undefined) return;
      writeLastSeen(hostId, Date.now());
      var changed = false;
      var hosts = snapshot.hosts.map(function (row) {
        if (row.id !== hostId || !row.unread) return row;
        changed = true;
        return Object.assign({}, row, { unread: 0 });
      });
      if (!changed) return;
      snapshot = { totals: totalsOf(hosts), hosts: hosts, failed: snapshot.failed };
      notify();
    },
  };
}

/** One module-level store; `apply` starts and stops its polling. */
var statusStore = createStatusStore();

/** Path a peer serves its own session state on. */
var PEER_STATUS_PATH = "/api/remote-dsh/self-status";

/** State-payload contract versions this reader understands. */
var PEER_STATUS_VERSIONS = [3, 4];

/**
 * The `pending` kinds a Workspace row renders as waiting for the operator.
 *
 * `approval` is a tool asking to escalate, `question` an ask-user-question, and
 * `plan-review` a plan submitted for approval — the same three the remote's own
 * sidebar collapses into one amber dot.
 */
var PENDING_KINDS = ["approval", "question", "plan-review"];

/**
 * Whether one peer session is blocked waiting for the operator.
 * @param session - one peer session row.
 * @returns true when the peer named a pending interaction kind.
 */
function isWaitingOnUser(session) {
  if (session === null || typeof session !== "object") return false;
  return typeof session.pending === "string" && PENDING_KINDS.indexOf(session.pending) !== -1;
}

/**
 * Read one peer's self-status directly from the browser.
 *
 * Cross-origin on purpose: DSH sends no CORS headers for its own `/api`, so the
 * only cross-origin read that can work is one this plugin's peer route opts
 * into. The request stays a CORS-simple GET — no `content-type`, no credentials
 * — so it needs no preflight, and the peer accepts it because the origin is
 * loopback. Routing it through the local Host half instead would work too, but
 * would tie the badge to a Host module reload, which needs a DSH restart.
 *
 * A peer reporting a version this reader does not know is treated exactly like a
 * non-peer: reachable, but with nothing to say. Version 3 predates `pending`, so
 * such a peer simply never contributes to the waiting count.
 * @param host - a registry row.
 * @param elapsedMs - how long ago this browser last viewed the host.
 * @returns a per-host aggregate row; never rejects.
 */
function readPeer(host, elapsedMs) {
  var base = { id: host.id, name: host.name, url: host.url };
  return fetch(host.url + PEER_STATUS_PATH, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "omit",
    cache: "no-store",
  }).then(function (response) {
    if (!response.ok) return Object.assign(base, { reachable: true, peer: false });
    return response.json().then(function (body) {
      if (body === null || typeof body !== "object" || PEER_STATUS_VERSIONS.indexOf(body.version) === -1) {
        return Object.assign(base, { reachable: true, peer: false });
      }
      if (body.available !== true) {
        return Object.assign(base, { reachable: true, peer: true, waiting: 0, running: 0, unread: 0 });
      }
      const sessions = Array.isArray(body.sessions) ? body.sessions : [];
      let waiting = 0;
      let running = 0;
      let unread = 0;
      sessions.forEach(function (session) {
        if (session === null || typeof session !== "object") return;
        // Waiting outranks activity, exactly as the remote's own row does: a
        // session blocked on the operator is not merely "busy".
        if (isWaitingOnUser(session)) { waiting += 1; return; }
        if (session.running === true) { running += 1; return; }
        if (isUnreadActivity(session, elapsedMs)) unread += 1;
      });
      return Object.assign(base, {
        reachable: true, peer: true, waiting: waiting, running: running, unread: unread,
      });
    });
  }).catch(function () {
    return Object.assign(base, { reachable: false, peer: false });
  });
}

/**
 * Whether one peer session counts as unread activity.
 *
 * `session.ageMs` is how long ago the peer last touched the session and
 * `elapsedMs` is how long ago this browser last looked — both durations, so the
 * verdict never depends on the two machines' clocks agreeing. A running session
 * is never "unread": it is reported by the running count instead.
 * @param session - one `{ running, ageMs }` row from a peer.
 * @param elapsedMs - milliseconds since this browser last viewed the host.
 * @returns true when the activity arrived after the last look.
 */
function isUnreadActivity(session, elapsedMs) {
  if (session === null || typeof session !== "object") return false;
  if (session.running === true) return false;
  var age = Number(session.ageMs);
  // A row without a usable duration is not evidence of recent activity, so it
  // counts as seen rather than as brand new.
  if (!Number.isFinite(age)) return false;
  return age < elapsedMs;
}

/**
 * Poll every configured host and publish the aggregate to the store.
 *
 * A host whose remote view is currently open has its "last seen" stamp advanced
 * on every poll, so anything that happens while the operator is watching counts
 * as seen — the dot then only reappears for activity that arrives while they are
 * looking somewhere else.
 * @returns the disposer stopping the interval.
 */
function startStatusPolling() {
  var stopped = false;
  var run = function () {
    api("/hosts", { method: "GET" }).then(function (body) {
      var hosts = Array.isArray(body.hosts) ? body.hosts : [];
      var now = Date.now();
      return Promise.all(hosts.map(function (host) {
        var viewing = viewingHostId === host.id;
        if (viewing) writeLastSeen(host.id, now);
        // Viewing means "seen up to now", so nothing counts as unread; otherwise
        // compare against how long ago this browser last looked.
        return readPeer(host, viewing ? 0 : Math.max(0, now - readLastSeen(host.id)));
      }));
    }).then(function (rows) {
      if (stopped) return;
      statusStore.set({ totals: statusStore.totalsOf(rows), hosts: rows, failed: false });
    }).catch(function () {
      if (stopped) return;
      statusStore.set({ totals: { waiting: 0, running: 0, unread: 0, unreachable: -1 }, hosts: [], failed: true });
    });
  };
  run();
  var timer = window.setInterval(run, STATUS_POLL_MS);
  return function () { stopped = true; window.clearInterval(timer) };
}

/** One colored dot followed by its count. */
function countBadge(color, count, label) {
  return h("span", {
    key: label,
    title: label + " " + String(count),
    style: { display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11, lineHeight: "14px", color: COLOR.dim },
  }, h(Dot, { color: color }), h("span", null, String(count)));
}

/**
 * Render the session-state badge that rides the rail glyph.
 *
 * Wide rows show a dot and count per state; the collapsed rail cell is a fixed
 * 36px box, so it carries a single dot in the highest-priority color and leaves
 * the counts to the tooltip. Colors and the priority order mirror the sidebar's
 * own session dots: a session waiting for the operator outranks one that is
 * merely busy, which outranks a notice that something happened while away.
 * @param totals - aggregate counts.
 * @param compact - true inside the 36px rail cell.
 * @returns the badge element, or null when there is nothing to say.
 */
function statusBadge(totals, compact) {
  var waiting = totals.waiting > 0;
  var running = totals.running > 0;
  var unread = totals.unread > 0;
  var unreachable = totals.unreachable > 0;
  if (compact) {
    var color = waiting
      ? COLOR.attention
      : (running ? COLOR.running : (unread ? COLOR.done : (unreachable ? COLOR.failure : null)));
    return color === null ? null : h(Dot, { color: color });
  }
  var parts = [];
  if (waiting) parts.push(countBadge(COLOR.attention, totals.waiting, "等待你回答"));
  if (running) parts.push(countBadge(COLOR.running, totals.running, "运行中"));
  if (unread) parts.push(countBadge(COLOR.done, totals.unread, "上次查看后有活动"));
  if (unreachable) parts.push(countBadge(COLOR.failure, totals.unreachable, "状态不可读"));
  if (parts.length === 0) return null;
  return h("span", { style: { display: "inline-flex", alignItems: "center", gap: 6 } }, parts);
}

/**
 * Human-readable breakdown for the glyph tooltip.
 * @param totals - aggregate counts.
 * @param hosts - per-host rows.
 * @returns the tooltip text.
 */
function statusTooltip(totals, hosts) {
  var lines = [];
  if (totals.waiting > 0) lines.push("等待你回答 " + String(totals.waiting) + "（在远程那边回复后消失）");
  if (totals.running > 0) lines.push("运行中 " + String(totals.running));
  if (totals.unread > 0) lines.push("上次查看后有活动 " + String(totals.unread) + "（打开远程即清零）");
  if (totals.unreachable > 0) lines.push("状态不可读 " + String(totals.unreachable));
  if (lines.length === 0) return "远程 · 无新活动";
  var perHost = (hosts || [])
    .filter(function (host) { return host && host.reachable === true && host.peer === true })
    .map(function (host) {
      return host.name + "：" + String(host.waiting || 0) + " 等待 / "
        + String(host.running || 0) + " 运行 / " + String(host.unread || 0) + " 有活动";
    });
  return "远程 · " + lines.join("，") + (perHost.length === 0 ? "" : "\n" + perHost.join("\n"));
}

/**
 * Call the plugin's own JSON route family.
 * @param path - path after the API prefix.
 * @param options - fetch options.
 * @returns the parsed JSON body.
 */
function api(path, options) {
  var init = options || {};
  init.headers = { "content-type": "application/json" };
  return fetch(API + path, init).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (body) {
      if (!response.ok) throw new Error((body && body.error) || ("HTTP " + response.status));
      return body;
    });
  });
}

/**
 * Whether an origin is loopback — the precondition for iframe embedding.
 * @param value - origin string.
 * @returns true when the hostname is loopback.
 */
function isLoopbackUrl(value) {
  try {
    var name = new URL(value).hostname;
    return name === "127.0.0.1" || name === "localhost" || name === "::1" || name === "[::1]";
  } catch (error) {
    return false;
  }
}

/** Whether this browser already submitted a token for a host. */
function isPaired(hostId) {
  if (!hostId) return false;
  try { return window.localStorage.getItem(PAIRED_KEY + hostId) !== null; } catch (error) { return false; }
}

/** Remember that a host's token was submitted, so its settings stay collapsed. */
function markPaired(hostId) {
  try { window.localStorage.setItem(PAIRED_KEY + hostId, String(Date.now())); } catch (error) { /* private mode */ }
}

/** One small colored status dot. */
function Dot(props) {
  return h("span", {
    style: {
      width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
      background: props.color, display: "inline-block",
    },
  });
}

/** A flat button styled from theme tokens. */
function Button(props) {
  var base = {
    appearance: "none", border: "1px solid " + COLOR.border, borderRadius: 6,
    background: props.primary ? COLOR.accent : "transparent",
    color: props.primary ? "#fff" : COLOR.text,
    font: "inherit", fontSize: 12, lineHeight: "16px", padding: "4px 10px",
    cursor: props.disabled ? "default" : "pointer",
    opacity: props.disabled ? 0.4 : 1, whiteSpace: "nowrap",
  };
  return h("button", {
    type: "button",
    style: Object.assign(base, props.style || {}),
    disabled: props.disabled === true,
    title: props.title,
    onClick: props.disabled === true ? undefined : props.onClick,
  }, props.label);
}

/** A muted separator between toolbar groups. */
function Divider() {
  return h("span", { style: { width: 1, height: 18, background: COLOR.border } });
}

/**
 * The rail icon. Icon only: the shell supplies the button, the tooltip, and the
 * accessible name from the list registration's label, and wraps this in an
 * `aria-hidden` glyph span.
 */
function RemoteIcon(props) {
  var size = props && typeof props.size === "number" ? props.size : 16;
  // The shell renders the wide row at 16 and the collapsed rail at 18 (its own
  // owner-prop contract), which is the only signal this seat gets about how
  // much room the glyph has.
  var compact = size > 16;
  var snapshot = React.useSyncExternalStore(
    statusStore.subscribe, statusStore.getSnapshot, statusStore.getSnapshot,
  );
  var glyph = h("svg", {
    viewBox: "0 0 16 16", width: size, height: size, fill: "none",
    stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round",
  },
    h("circle", { cx: 8, cy: 8, r: 6.1 }),
    h("path", { d: "M1.9 8h12.2" }),
    h("path", { d: "M8 1.9c1.75 1.9 1.75 10.3 0 12.2" }),
    h("path", { d: "M8 1.9c-1.75 1.9-1.75 10.3 0 12.2" }),
  );
  var badge = statusBadge(snapshot.totals, compact);
  if (badge === null) return glyph;
  return h("span", {
    "data-dsh-remote-badge": "",
    title: statusTooltip(snapshot.totals, snapshot.hosts),
    style: { display: "inline-flex", alignItems: "center", gap: compact ? 3 : 7 },
  }, glyph, badge);
}

/**
 * The full-page remote workspace.
 *
 * Rendered into `shell.overlay`, so its own box covers the app frame. It stays
 * mounted for the plugin's whole life and is hidden — never unmounted — while
 * the rail row is not selected, which is what keeps the embedded remote SPA
 * from reloading on every visit. Every hook runs unconditionally; the effects
 * return early while hidden so a background tab does no polling.
 *
 * `usePanelInfo` is a framework standard prop on every slot scope, which is
 * how this knows whether the takeover is on.
 *
 * @param props - framework props plus `onExit`.
 */
function RemoteWorkspace(props) {
  var usePanelInfo = props.usePanelInfo;
  var active = usePanelInfo(function (info) { return info.activePanelId === PANEL_ID; });

  var hostsState = React.useState([]);
  var hosts = hostsState[0];
  var setHosts = hostsState[1];

  var activeIdState = React.useState(function () {
    try { return window.localStorage.getItem(ACTIVE_KEY); } catch (error) { return null; }
  });
  var activeId = activeIdState[0];
  var setActiveId = activeIdState[1];

  var probeState = React.useState(null);
  var probe = probeState[0];
  var setProbe = probeState[1];

  var formState = React.useState(null);
  var form = formState[0];
  var setForm = formState[1];

  var noticeState = React.useState(null);
  var notice = noticeState[0];
  var setNotice = noticeState[1];

  var tokenState = React.useState("");
  var token = tokenState[0];
  var setToken = tokenState[1];

  var pairState = React.useState(null);
  var pairing = pairState[0];
  var setPairing = pairState[1];

  var nonceState = React.useState(0);
  var nonce = nonceState[0];
  var setNonce = nonceState[1];

  var settingsState = React.useState(false);
  var settingsOpen = settingsState[0];
  var setSettingsOpen = settingsState[1];

  var fromServer = React.useRef(false);

  var load = React.useCallback(function () {
    return api("/hosts", { method: "GET" }).then(function (body) {
      var next = Array.isArray(body.hosts) ? body.hosts : [];
      fromServer.current = true;
      setHosts(next);
      return next;
    }).catch(function (error) {
      setNotice("读取主机列表失败：" + String(error.message || error));
      return [];
    });
  }, []);

  React.useEffect(function () {
    if (!active) return undefined;
    void load();
    return undefined;
  }, [active, load]);

  // Keep the selection pointing at a host that still exists.
  React.useEffect(function () {
    if (!active || !fromServer.current) return;
    if (hosts.length === 0) {
      if (activeId !== null) setActiveId(null);
      return;
    }
    if (!hosts.some(function (host) { return host.id === activeId; })) {
      setActiveId(hosts[0].id);
    }
  }, [active, hosts, activeId, setActiveId]);

  React.useEffect(function () {
    try {
      if (activeId === null) window.localStorage.removeItem(ACTIVE_KEY);
      else window.localStorage.setItem(ACTIVE_KEY, activeId);
    } catch (error) { /* private mode: selection simply does not persist */ }
  }, [activeId]);

  var selected = null;
  for (var index = 0; index < hosts.length; index += 1) {
    if (hosts[index].id === activeId) { selected = hosts[index]; break; }
  }
  var selectedUrl = selected === null ? null : selected.url;

  // Probe the selected host, then keep polling it while the takeover is on.
  React.useEffect(function () {
    if (!active || selectedUrl === null) { setProbe(null); return undefined; }
    var cancelled = false;
    var run = function () {
      api("/probe", { method: "POST", body: JSON.stringify({ url: selectedUrl }) })
        .then(function (result) { if (!cancelled) setProbe(result); })
        .catch(function (error) {
          if (!cancelled) setProbe({ reachable: false, error: String(error.message || error) });
        });
    };
    run();
    var timer = window.setInterval(run, PROBE_INTERVAL_MS);
    return function () { cancelled = true; window.clearInterval(timer); };
  }, [active, selectedUrl]);

  // Tell the badge store which host's view is open: opening one clears that
  // host's unread count on the spot, and anything arriving while it stays open
  // counts as seen.
  React.useEffect(function () {
    statusStore.setViewing(active ? activeId : null);
    return function () { statusStore.setViewing(null); };
  }, [active, activeId]);

  // Escape leaves, as long as focus has not been handed to the remote document
  // (a focused iframe swallows the key, which is why the button is primary).
  var onExit = props.onExit;
  React.useEffect(function () {
    if (!active) return undefined;
    var onKey = function (event) { if (event.key === "Escape") onExit(); };
    window.addEventListener("keydown", onKey);
    return function () { window.removeEventListener("keydown", onKey); };
  }, [active, onExit]);

  var save = React.useCallback(function (input) {
    var isNew = typeof input.id !== "string" || input.id === "";
    return api("/hosts", { method: "POST", body: JSON.stringify(input) }).then(function (body) {
      setHosts(Array.isArray(body.hosts) ? body.hosts : []);
      setForm(null);
      setNotice(null);
      if (isNew) {
        var created = (body.hosts || []).filter(function (host) { return host.url === input.url; }).pop();
        if (created) setActiveId(created.id);
        // A host that was just added has never been paired and pairing is the
        // immediate next step, so this is the one automatic open — triggered by
        // the user's own add, never by the default state.
        setSettingsOpen(true);
      }
    }).catch(function (error) {
      setNotice("保存失败：" + String(error.message || error));
    });
  }, []);

  var remove = React.useCallback(function (id) {
    return api("/hosts/" + encodeURIComponent(id), { method: "DELETE" }).then(function (body) {
      setHosts(Array.isArray(body.hosts) ? body.hosts : []);
      setPairing(null);
      setSettingsOpen(false);
      setNotice(null);
    }).catch(function (error) {
      setNotice("删除失败：" + String(error.message || error));
    });
  }, []);

  var frameSrc = null;
  if (selected !== null) {
    frameSrc = pairing === selected.id && token !== ""
      ? selected.url + "/?token=" + encodeURIComponent(token)
      : selected.url + "/";
  }

  // Short label for the bar; the full sentence rides the tooltip. The probe
  // only proves the port and the remote DSH are alive — whether THIS browser is
  // paired is a cookie fact it cannot see, so the label never claims pairing.
  var status = { color: COLOR.faint, text: "未探测", detail: "尚未探测该主机。" };
  if (probe !== null) {
    if (probe.reachable !== true) {
      status = {
        color: COLOR.bad, text: "端口不通",
        detail: "端口不通" + (probe.error ? " · " + probe.error : ""),
      };
    } else if (probe.dshAuthRequired === true) {
      status = {
        color: COLOR.ok, text: "已连通",
        detail: "已连通 · 远程 DSH 存活。若画面提示需要认证，粘贴 token 配对。",
      };
    } else {
      status = { color: COLOR.ok, text: "已连通", detail: "已连通 · HTTP " + String(probe.status) };
    }
  }

  var chips = hosts.map(function (host) {
    var isSelected = host.id === activeId;
    return h("button", {
      key: host.id,
      type: "button",
      title: host.url,
      onClick: function () { setActiveId(host.id); setNotice(null); },
      style: {
        appearance: "none", font: "inherit", fontSize: 12, cursor: "pointer",
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 10px", borderRadius: 999,
        border: "1px solid " + (isSelected ? COLOR.accent : COLOR.border),
        background: isSelected ? COLOR.raised : "transparent",
        color: COLOR.text,
      },
    },
      h(Dot, { color: isSelected ? status.color : COLOR.faint }),
      h("span", null, host.name),
    );
  });

  // The settings row is COLLAPSED by default, and the ⚙ toggle is the only
  // thing that opens or closes it. Nothing may OR itself into this predicate:
  // a per-host condition that forced the row open is exactly what used to
  // make ⚙ unable to collapse it. `unpaired` only informs the tooltip.
  var unpaired = selected !== null && !isPaired(selected.id);
  var showSettings = settingsOpen === true;

  var bar = h("div", {
    style: {
      flexShrink: 0, background: COLOR.chrome, borderBottom: "1px solid " + COLOR.border,
    },
  },
    h("div", {
      style: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "6px 12px" },
    },
      h(Button, {
        label: "← 返回本地 DSH",
        onClick: onExit,
        title: "回到本地会话（Esc）",
        style: { fontWeight: 600 },
      }),
      h(Divider),
      chips,
      h(Button, {
        label: "＋ 添加",
        title: "添加一台远程 DSH",
        onClick: function () { setForm({ id: "", name: "", url: "http://127.0.0.1:3081" }); setNotice(null); },
      }),
      h(Button, {
        label: "⚙",
        title: showSettings
          ? "收起设置"
          : (unpaired ? "展开设置（该主机尚未配对过，展开可粘贴 token）" : "展开设置"),
        onClick: function () { setSettingsOpen(!settingsOpen); },
      }),
      h("span", { style: { flex: 1 } }),
      h(Dot, { color: status.color }),
      h("span", { title: status.detail, style: { fontSize: 12, color: COLOR.dim, cursor: "default" } }, status.text),
    ),
    showSettings && selected !== null && form === null
      ? h("div", {
          style: {
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            padding: "0 12px 8px", fontSize: 12, color: COLOR.dim,
          },
        },
          h("code", { style: { color: COLOR.faint } }, selected.url),
          h("span", { style: { flex: 1 } }),
          h("input", {
            value: token,
            placeholder: "粘贴远程 dsh web 打印的 token",
            onChange: function (event) { setToken(event.target.value); },
            style: {
              font: "inherit", fontSize: 12, width: 260, padding: "4px 8px", borderRadius: 6,
              border: "1px solid " + COLOR.border, background: "transparent", color: COLOR.text,
            },
          }),
          h(Button, {
            label: "配对",
            disabled: token.trim() === "",
            title: "把 token 交给远程实例换取会话 cookie",
            onClick: function () { setPairing(selected.id); setNotice(null); setNonce(nonce + 1); },
          }),
          h(Button, { label: "重载", title: "重新加载远程画面", onClick: function () { setPairing(null); setNonce(nonce + 1); } }),
          h(Button, {
            label: "新窗口",
            title: "在浏览器新标签页打开",
            onClick: function () { window.open(selected.url + "/", "_blank", "noopener,noreferrer"); },
          }),
          h(Button, {
            label: "编辑",
            onClick: function () { setForm({ id: selected.id, name: selected.name, url: selected.url }); },
          }),
          h(Button, {
            label: "删除",
            onClick: function () {
              if (window.confirm("删除远程主机「" + selected.name + "」？")) void remove(selected.id);
            },
          }),
        )
      : null,
  );

  var body = null;
  if (form !== null) {
    body = h("form", {
      style: { padding: 16, display: "flex", flexDirection: "column", gap: 10, maxWidth: 560 },
      onSubmit: function (event) {
        event.preventDefault();
        void save({ id: form.id, name: form.name, url: form.url });
      },
    },
      h("label", { style: { fontSize: 12, color: COLOR.dim } }, "名称"),
      h("input", {
        value: form.name, placeholder: "例如 服务器 A", autoFocus: true,
        onChange: function (event) { setForm(Object.assign({}, form, { name: event.target.value })); },
        style: {
          font: "inherit", padding: "6px 10px", borderRadius: 6,
          border: "1px solid " + COLOR.border, background: "transparent", color: COLOR.text,
        },
      }),
      h("label", { style: { fontSize: 12, color: COLOR.dim } }, "地址（必须是本地转发出来的 127.0.0.1 端口）"),
      h("input", {
        value: form.url, placeholder: "http://127.0.0.1:3081",
        onChange: function (event) { setForm(Object.assign({}, form, { url: event.target.value })); },
        style: {
          font: "inherit", padding: "6px 10px", borderRadius: 6,
          border: "1px solid " + COLOR.border, background: "transparent", color: COLOR.text,
        },
      }),
      !isLoopbackUrl(form.url) && form.url.trim() !== ""
        ? h("div", { style: { fontSize: 12, color: COLOR.warn, lineHeight: 1.6 } },
            "⚠ 该地址不是本地回环地址。远程 DSH 的会话 cookie 是 SameSite=Strict，"
            + "跨站 iframe 不会带上它，嵌入会直接 401。请改用 frpc stcp/xtcp visitor "
            + "或 ssh -L 把它映射成本地 127.0.0.1 端口。")
        : null,
      h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
        h(Button, { label: "保存", primary: true, onClick: function () { void save({ id: form.id, name: form.name, url: form.url }); } }),
        h(Button, { label: "取消", onClick: function () { setForm(null); } }),
      ),
    );
  } else if (selected === null) {
    body = h("div", {
      style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 },
    }, h("div", { style: { fontSize: 13, color: COLOR.dim, textAlign: "center", lineHeight: 1.9 } },
      h("div", null, "还没有配置远程 DSH。"),
      h("div", { style: { color: COLOR.faint, fontSize: 12 } },
        "先在另一台主机上跑 dsh web，再用 frpc stcp/xtcp visitor 或 ssh -L 把它映射到本机 127.0.0.1 端口。"),
    ));
  } else {
    body = h("iframe", {
      key: String(nonce) + ":" + (pairing === selected.id ? "pair" : "live") + ":" + selected.id,
      src: frameSrc,
      title: selected.name + " 远程 GUI",
      referrerPolicy: "no-referrer",
      allow: "clipboard-write; clipboard-read; fullscreen",
      onLoad: function () {
        if (pairing === selected.id) {
          markPaired(selected.id);
          setPairing(null);
          setSettingsOpen(false);
          setToken("");
          setNotice("已提交 token。若画面仍提示需要认证，说明 token 已失效——到远程主机重启后的 dsh web 输出里取新的。");
        }
      },
      style: { flex: 1, width: "100%", border: "none", background: COLOR.panel, minHeight: 0 },
    });
  }

  return h("div", {
    "data-dsh-remote-workspace": "",
    "data-active": active ? "true" : undefined,
    style: {
      position: "absolute", inset: 0, zIndex: 1,
      // Hidden, never unmounted: `display: none` keeps the iframe's browsing
      // context, so the remote SPA does not reload when the rail row is
      // reselected.
      display: active ? "flex" : "none",
      flexDirection: "column", minHeight: 0,
      background: COLOR.panel, color: COLOR.text,
    },
  },
    bar,
    !isLoopbackUrl(selected === null ? "" : selected.url) && selected !== null
      ? h("div", {
          style: {
            padding: "6px 12px", fontSize: 12, color: COLOR.warn,
            borderBottom: "1px solid " + COLOR.border, flexShrink: 0,
          },
        }, "⚠ 非回环地址：SameSite=Strict cookie 不会随跨站 iframe 发送，嵌入会 401。")
      : null,
    notice !== null
      ? h("div", {
          style: {
            padding: "6px 12px", fontSize: 12, color: COLOR.dim,
            borderBottom: "1px solid " + COLOR.border, flexShrink: 0,
          },
        }, notice)
      : null,
    body,
  );
}

/**
 * Raise this plugin's rail row above the local "New Session" button.
 *
 * The sidebar shell draws its own blocks in a fixed order — brand row, New
 * Session, the `sidebar.panellist` nav, the workspace browser, the foot — and
 * the panellist seat sits BELOW New Session. There is no seat in the brand row
 * itself: its two slots render inside an `aria-hidden` button that starts a
 * session, so interactive content cannot go there. The row is therefore raised
 * with flex `order` on the shell's column.
 *
 * `.logoRow` and `.panelList` both carry `margin-bottom: 8px` and New Session
 * keeps its own, so the swap needs no spacing fix-up: the 8px rhythm is
 * already the same on both sides.
 *
 * Addressing: `[data-slot="sidebar"]` is the documented anchor seam every slot
 * render site exposes for styles, and the class substrings survive CSS-module
 * hashing (`WNUpnq_panelList`). If the shell renames either class the rule
 * simply stops matching and the row stays where it is — the failure mode is
 * "no change", never breakage.
 *
 * The rule moves the whole panellist nav, not one row: every global panel
 * shares that seat, so a second plugin's panel would move up with this one.
 * That grouping (global panels above the local New Session) is the intent.
 */
var SIDEBAR_ORDER_CSS = '[data-slot="sidebar"] [class*="logoRow"]{order:-2}'
  + '[data-slot="sidebar"] [class*="panelList"]{order:-1}';

/**
 * Install the sidebar order rule and return its disposer.
 * @returns a function removing the injected stylesheet.
 */
function installSidebarOrder() {
  var style = document.createElement("style");
  style.setAttribute("data-dsh-remote-dsh", "sidebar-order");
  style.textContent = SIDEBAR_ORDER_CSS;
  document.head.appendChild(style);
  return function () { style.remove(); };
}

/** Required services. */
var inject = ["slots"];

/**
 * Client plugin body: contribute the rail row, the selection key, and the
 * full-page takeover.
 * @param ctx - client root context.
 */
function apply(ctx) {
  // A host running the peer role publishes its state to somebody else; it must
  // not grow a rail row of its own. The marker is injected into the index by
  // this same package's Node half, so the decision is synchronous — an async
  // role probe would flash the row before hiding it.
  if (typeof window !== "undefined" && window.__DSH_REMOTE_DDH_ROLE__ === "peer") return;

  // The rail badge's data. One interval for the whole page, owned by this fiber.
  ctx.effect(function () { return startStatusPolling(); }, "dsh-remote-dsh: status polling");

  // The rail row has to sit above New Session; the sidebar shell draws the
  // panellist seat below it, so the column order is corrected with one scoped
  // stylesheet owned by this fiber.
  ctx.effect(function () { return installSidebarOrder(); }, "dsh-remote-dsh: sidebar order");

  // Selection is layout state, so leaving is `selectPanel(null)`: the same
  // call the shell's own rail rows make. Read optionally — a composition
  // without ui-layout simply gets a no-op exit.
  var exit = function () {
    var layout = ctx.get("layout");
    if (layout !== undefined) layout.selectPanel(null);
  };

  function Overlay(props) {
    return h(RemoteWorkspace, Object.assign({}, props, { onExit: exit }));
  }

  ctx.slots.inject("sidebar.panellist", function () {
    return ctx.slots.register({
      name: "sidebar.panellist",
      id: PANEL_ID,
      order: 90,
      label: "远程",
    }, RemoteIcon);
  });

  // Exists only to satisfy ui-layout's pair check; renders nothing because the
  // overlay covers the frame the moment this key becomes active.
  ctx.slots.inject("main", function () {
    return ctx.slots.register({ name: "main", key: PANEL_ID }, function () { return null; });
  });

  ctx.slots.inject("shell.overlay", function () {
    return ctx.slots.register({ name: "shell.overlay", id: PANEL_ID, order: 10 }, Overlay);
  });
}

module.exports.apply = apply;
module.exports.inject = inject;
module.exports.RemoteWorkspace = RemoteWorkspace;
module.exports.RemoteIcon = RemoteIcon;
module.exports.PANEL_ID = PANEL_ID;
module.exports.statusBadge = statusBadge;
module.exports.statusTooltip = statusTooltip;
module.exports.isUnreadActivity = isUnreadActivity;
module.exports.isWaitingOnUser = isWaitingOnUser;
module.exports.createStatusStore = createStatusStore;
module.exports.statusStore = statusStore;
return module.exports; } });
