"use strict"

const { validClient, keyFor, now, fresh, targetType } = require("./util")

const sharedClientID = "_shared"

const defaults = {
  maxTargets: 8,
  targetIdleMs: 30 * 60 * 1000,
  cleanupIntervalMs: 5 * 60 * 1000,
  idleRecoveryThresholdMs: 300000,
  idleRecoveryWindowMs: 30000,
}

function emptyHead() {
  return {
    sessionID: null,
    directory: null,
    messageCount: 0,
    tailID: null,
    updatedAt: 0,
  }
}

function createState(target) {
  return {
    target,
    targetKey: keyFor(target),
    targetType: "attach-only",
    targetStatus: "unknown",
    admission: "probe",
    availabilityAt: 0,
    failureReason: null,
    failureCount: 0,
    backoffUntil: 0,
    lastFailureAt: 0,
    config: undefined,
    clients: new Map(),
    latestHead: emptyHead(),
    activeHeads: new Map(),
    syncVersion: 0,
    lastSyncAt: 0,
    meta: undefined,
    metaAt: 0,
    inventory: [],
    inventoryAt: 0,
    sessionList: [],
    workspaceSessions: new Map(),
    lists: new Map(),
    messages: new Map(),
    details: new Map(),
    projects: new Map(),
    bootstrap: new Map(),
    assets: new Map(),
    shellHtml: null,
    heavyActive: 0,
    heavyBackgroundActive: 0,
    heavyQueue: [],
    heavyBackgroundQueue: [],
    backgroundActive: 0,
    backgroundQueue: [],
    backgroundKeys: new Set(),
    ptyActive: 0,
    offline: false,
    offlineReason: null,
    resumeTimer: undefined,
    onResume: undefined,
    watcherTimer: undefined,
    watcherBusy: false,
    stats: {
      cacheHit: 0,
      cacheMiss: 0,
      cacheBypass: 0,
      staleLaunch: 0,
      upstreamFetch: 0,
      heavyQueued: 0,
      backgroundQueued: 0,
    },
    lastError: null,
    lastReason: null,
    lastReasonClient: null,
    lastAccessAt: now(),
    promise: undefined,
    promiseStartedAt: 0,
  }
}

function createClientState(id) {
  return {
    id,
    warm: {
      active: false,
      ready: false,
      first: true,
      percent: 0,
      stage: "idle",
      note: "Waiting",
      cachedAt: 0,
      latestSessionID: undefined,
      latestDirectory: undefined,
      snapshotCount: 0,
      error: null,
    },
    lastError: null,
    lastAccessAt: now(),
    activeSessionID: undefined,
    activeDirectory: undefined,
    view: null,
    viewHead: emptyHead(),
    remoteHead: emptyHead(),
    syncState: "idle",
    staleReason: null,
    lastAction: "noop",
    lastActionAt: 0,
    localSubmitUntil: 0,
    refreshFailures: 0,
    resumeSafeUntil: 0,
    resumeReason: null,
  }
}

function setClientView(client, view) {
  client.view = view || null
}

function parseHeadBody(body) {
  try {
    const rows = JSON.parse(body || "[]")
    if (!Array.isArray(rows)) return []
    return rows
  } catch {
    return []
  }
}

function headFromEntry(entry, fallback) {
  const base = fallback || emptyHead()
  if (!entry) return { ...base }
  const rows = parseHeadBody(entry.body)
  const tail = rows.length ? rows[rows.length - 1] : null
  return {
    sessionID: entry.sessionID || base.sessionID || null,
    directory: entry.directory || base.directory || null,
    messageCount: rows.length,
    tailID: tail?.info?.id || tail?.id || null,
    updatedAt: entry.at || now(),
  }
}

function messageHead(state, directory, sessionID, limit) {
  return headFromEntry(
    state.messages.get(`${directory}\n${sessionID}\n${limit}`),
    { sessionID, directory, messageCount: 0, tailID: null, updatedAt: 0 },
  )
}

function setClientHeads(state, client, viewHead, remoteHead) {
  client.viewHead = viewHead ? { ...viewHead } : emptyHead()
  client.remoteHead = remoteHead ? { ...remoteHead } : emptyHead()
  state.activeHeads.set(client.id, { ...client.remoteHead })
  if (client.remoteHead.sessionID) state.latestHead = { ...client.remoteHead }
  state.syncVersion += 1
  state.lastSyncAt = now()
}

function setSyncState(client, syncState, staleReason, lastAction) {
  client.syncState = syncState
  client.staleReason = staleReason
  client.lastAction = lastAction
  client.lastActionAt = now()
}

function syncAction(state, client) {
  if (state.offline) return "noop"
  if (client.syncState !== "stale") return "noop"
  if (client.localSubmitUntil && client.localSubmitUntil > now()) return "defer"
  if (clientSafeMode(client) || backgroundWarmPaused(state)) return "defer"
  if (!client.view?.sessionID || !client.view?.directory) return "re-enter"
  if ((client.refreshFailures || 0) >= 2) return "re-enter"
  return "soft-refresh"
}

function targetAdmission(state) {
  if (state.offline) {
    return state.targetType === "launcher-managed" ? "launcher-managed-unavailable" : "attach-only-unavailable"
  }
  if (state.meta?.ready) return "enter"
  if (state.meta && !state.meta.ready) return "no-session"
  return "probe"
}

function syncClientView(state, client) {
  const latest = state.meta?.sessions?.latest
  if (!client.view && client.activeSessionID && client.activeDirectory) {
    setClientView(client, {
      sessionID: client.activeSessionID,
      directory: client.activeDirectory,
      pathname: null,
    })
  }
  const view = client.view
  if (!view?.sessionID || !view.directory) {
    if (state.offline) setSyncState(client, "offline", "target-offline", client.lastAction || "noop")
    return
  }
  client.activeSessionID = view.sessionID
  client.activeDirectory = view.directory
  const remoteHead = messageHead(state, view.directory, view.sessionID, 80)
  const sameView = client.viewHead?.sessionID === view.sessionID && client.viewHead?.directory === view.directory
  const localSubmit = client.localSubmitUntil && client.localSubmitUntil > now()
  const viewHead = sameView && !localSubmit ? client.viewHead : remoteHead
  setClientHeads(state, client, viewHead, remoteHead)
  if (state.offline) {
    setSyncState(client, "offline", "target-offline", client.lastAction || "noop")
    return
  }
  if (
    viewHead.sessionID === remoteHead.sessionID &&
    viewHead.directory === remoteHead.directory &&
    (viewHead.messageCount !== remoteHead.messageCount || viewHead.tailID !== remoteHead.tailID)
  ) {
    setSyncState(client, "stale", client.staleReason || "head-advanced", client.lastAction || "noop")
    return
  }
  setSyncState(client, "live", null, "noop")
}

function touchState(state) {
  state.lastAccessAt = now()
}

function touchClient(state, client, config) {
  const cfg = config || defaults
  const stamp = now()
  if (client.lastAccessAt && stamp - client.lastAccessAt >= cfg.idleRecoveryThresholdMs) {
    enterResumeSafe(state, client, "idle-resume", cfg)
  }
  client.lastAccessAt = stamp
}

function clientSafeMode(client) {
  return Boolean(client.resumeSafeUntil && client.resumeSafeUntil > now())
}

function enterResumeSafe(state, client, reason, config) {
  const cfg = config || defaults
  client.resumeSafeUntil = Math.max(client.resumeSafeUntil || 0, now() + cfg.idleRecoveryWindowMs)
  client.resumeReason = reason
  scheduleBackgroundResume(state)
}

function backgroundWarmPaused(state) {
  if (state.ptyActive > 0) return true
  for (const client of state.clients.values()) {
    if (clientSafeMode(client)) return true
  }
  return false
}

function scheduleBackgroundResume(state) {
  if (state.resumeTimer) clearTimeout(state.resumeTimer)
  const delay = Math.max(0, ...[...state.clients.values()].map((c) => Math.max(0, (c.resumeSafeUntil || 0) - now())))
  if (!delay) {
    state.resumeTimer = undefined
    if (!backgroundWarmPaused(state) && typeof state.onResume === 'function') {
      state.onResume(state)
    }
    return
  }
  state.resumeTimer = setTimeout(() => {
    state.resumeTimer = undefined
    if (backgroundWarmPaused(state)) return
    if (typeof state.onResume === 'function') {
      state.onResume(state)
    }
  }, delay)
  state.resumeTimer.unref?.()
}

function ensureClientState(state, id, config) {
  const key = validClient(id) ? id : sharedClientID
  const hit = state.clients.get(key)
  if (hit) {
    touchClient(state, hit, config)
    return hit
  }
  const next = createClientState(key)
  state.clients.set(key, next)
  return next
}

function ensureState(states, target, config) {
  const cfg = config || {}
  const key = keyFor(target)
  const hit = states.get(key)
  if (hit) {
    hit.config = cfg
    hit.targetType = targetType(target, cfg)
    hit.admission = targetAdmission(hit)
    touchState(hit)
    return hit
  }
  const next = createState(target)
  next.config = cfg
  next.targetType = targetType(target, cfg)
  next.admission = targetAdmission(next)
  next.onResume = (s) => {
    const { drainHeavy, pumpBackground } = require("./heavy")
    drainHeavy(s)
    pumpBackground(s)
  }
  const { hydrateStateFromDisk } = require("./sync/disk-cache")
  hydrateStateFromDisk(next, cfg)
  states.set(key, next)
  if (states.size > (cfg.maxTargets || defaults.maxTargets)) cleanupStates(states, true, cfg)
  const { startWatcher } = require("./sync/watcher")
  startWatcher(next, cfg)
  return next
}

function cleanupStates(states, force, config) {
  const cfg = config || defaults
  const threshold = now() - cfg.targetIdleMs
  for (const [key, state] of [...states.entries()]) {
    for (const [id, client] of state.clients.entries()) {
      if (client.lastAccessAt < threshold && !client.warm.active) state.clients.delete(id)
    }
    if (!force && state.lastAccessAt >= threshold) continue
    if (state.promise || state.heavyActive || state.backgroundActive || state.ptyActive || state.resumeTimer) continue
    if (state.resumeTimer) clearTimeout(state.resumeTimer)
    if (state.watcherTimer) {
      const { stopWatcher } = require("./sync/watcher")
      stopWatcher(state)
    }
    states.delete(key)
  }
  if (!force || states.size <= cfg.maxTargets) return
  const victims = [...states.entries()]
    .filter(([, s]) => !s.promise && !s.heavyActive && !s.backgroundActive && !s.ptyActive && !s.resumeTimer)
    .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
  while (states.size > cfg.maxTargets && victims.length) {
    const [key, state] = victims.shift()
    if (state.watcherTimer) {
      const { stopWatcher } = require("./sync/watcher")
      stopWatcher(state)
    }
    states.delete(key)
  }
}

function setWarm(client, patch) {
  client.warm = { ...client.warm, ...patch }
}

function warmBusy(state) {
  return Boolean(state.promise || state.heavyActive || state.backgroundActive || state.backgroundQueue.length)
}

function setLastReason(state, client, reason) {
  state.lastReason = reason
  state.lastReasonClient = client?.id || sharedClientID
}

function clearLastReason(state, client) {
  const key = client?.id || sharedClientID
  if (!state.lastReason || state.lastReasonClient !== key) return
  state.lastReason = null
  state.lastReasonClient = null
}

function rememberActiveSession(client, reqUrl) {
  const { decodeDir } = require("./util")
  const match = reqUrl.pathname.match(/^\/[^/]+\/session\/([^/]+)$/)
  if (!match) return
  const directory = decodeDir(reqUrl.pathname.split("/")[1] || "") || client.activeDirectory
  const sessionID = decodeURIComponent(match[1])
  client.activeDirectory = directory
  client.activeSessionID = sessionID
  setClientView(client, { directory, sessionID, pathname: reqUrl.pathname })
}

function requestDirectory(client, reqUrl) {
  return reqUrl.searchParams.get("directory") || client?.activeDirectory || client?.warm?.latestDirectory
}

function messageBypass(state, client, directory, sessionID, limit) {
  if (limit !== 80) return false
  if (client?.activeSessionID === sessionID && client?.activeDirectory === directory) return true
  return state.meta?.sessions?.latest?.id === sessionID && state.meta?.sessions?.latest?.directory === directory
}

function messageBypassReason(state, client, directory, sessionID, limit) {
  if (limit !== 80) return null
  if (client?.activeSessionID === sessionID && client?.activeDirectory === directory) return "active-session-bypass"
  if (state.meta?.sessions?.latest?.id === sessionID && state.meta?.sessions?.latest?.directory === directory) return "latest-session-bypass"
  return null
}

function relayPriority(reqUrl, client) {
  if (reqUrl.pathname === "/session") return "foreground"
  const { messageRequestInfo } = require("./util")
  const info = messageRequestInfo(reqUrl)
  if (!info) return "foreground"
  if (info.limit <= 80) return "foreground"
  if (!client || client.id === sharedClientID) return "foreground"
  return client.activeSessionID && client.activeSessionID !== info.sessionID ? "background" : "foreground"
}

module.exports = {
  sharedClientID,
  defaults,
  createState,
  createClientState,
  emptyHead,
  touchState,
  touchClient,
  clientSafeMode,
  enterResumeSafe,
  backgroundWarmPaused,
  scheduleBackgroundResume,
  ensureClientState,
  ensureState,
  cleanupStates,
  setWarm,
  setClientView,
  messageHead,
  setClientHeads,
  setSyncState,
  syncAction,
  targetAdmission,
  syncClientView,
  warmBusy,
  setLastReason,
  clearLastReason,
  rememberActiveSession,
  requestDirectory,
  messageBypass,
  messageBypassReason,
  relayPriority,
}
