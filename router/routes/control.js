"use strict"

const { json, withRelay, relayHeaders, runtimeHeaders } = require("../http")
const { launchPage } = require("../pages")
const { clientSafeMode, clearLastReason, setLastReason, warmBusy, backgroundWarmPaused, syncAction, syncClientView, targetAdmission, setClientView } = require("../state")
const { syncWarm, warm, refresh, metaEnvelope } = require("../warm")
const { classifyError, isMobile, validClient, encodeDir } = require("../util")
const { targetCookie } = require("../context")
const { subscribeTarget } = require("../sync/bus")
const { versionInfo } = require("../version")

function setTargetCookie(res, target) {
  res.setHeader("Set-Cookie", `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax`)
}

function clearTargetCookie(res) {
  res.setHeader("Set-Cookie", `${targetCookie}=; Path=/; Max-Age=0; SameSite=Lax`)
}

function handoffLocation(target, launch) {
  return `/${launch.directory}/session/${encodeURIComponent(launch.sessionID)}?host=${encodeURIComponent(target.host)}&port=${encodeURIComponent(target.port)}&client=${encodeURIComponent(launch.client)}`
}

function progressPayload(state, client) {
  syncWarm(state, client)
  state.admission = targetAdmission(state)
  const metaReady = Boolean(state.meta?.ready && state.meta?.sessions?.latest?.id && state.meta?.sessions?.latest?.directory)
  const launchReady = Boolean(metaReady && state.enterReady && state.enterReadySessionID === state.meta?.sessions?.latest?.id && state.enterReadyDirectory === state.meta?.sessions?.latest?.directory)
  // v0.1.6 Invariant #3: Explicit user context always > latest
  // Priority: client.active* (URL params / explicit intent) > meta.sessions.latest (global fallback)
  // Removed client.view from priority — it's stale during workspace switch, causing jump-back
  const launchTarget = (client.activeSessionID && client.activeDirectory)
    ? { id: client.activeSessionID, directory: client.activeDirectory }
    : (state.meta?.sessions?.latest ? { id: state.meta.sessions.latest.id, directory: state.meta.sessions.latest.directory } : null)
  syncClientView(state, client)
  const refreshing = Boolean(client.warm.active && warmBusy(state))
  const action = syncAction(state, client)
  const baseSyncState = state.offline ? "offline" : launchReady ? "live" : "idle"
  const stickySyncState = client.syncState === "offline" && !state.offline ? null : client.syncState
  const syncState = action === "defer" && client.syncState === "stale"
    ? "protected"
    : (!stickySyncState || (stickySyncState === "idle" && launchReady) ? baseSyncState : stickySyncState)
  if (client.lastAction !== action) {
    client.lastAction = action
    client.lastActionAt = Date.now()
  }
  const payload = {
    target: state.target,
    targetType: state.targetType,
    targetStatus: state.targetStatus,
    admission: state.admission,
    failureReason: state.failureReason,
    failureCount: state.failureCount,
    backoffUntil: state.backoffUntil,
    ready: client.warm.ready && Boolean(state.meta?.ready),
    launchReady,
    enterReady: launchReady,
    enterReadyReason: state.enterReadyReason,
    refreshing,
    resumeSafeMode: clientSafeMode(client),
    backgroundWarmPaused: backgroundWarmPaused(state),
    retryAfterMs: clientSafeMode(client) ? (state.config?.recoveryRetryMs || 1500) : 450,
    offline: state.offline,
    offlineReason: state.offlineReason,
    cacheState: !state.meta ? "cold" : refreshing ? "stale" : "warm",
    syncState,
    staleReason: client.staleReason || null,
    lastAction: action,
    lastActionAt: client.lastActionAt || 0,
    viewHead: client.viewHead || null,
    remoteHead: client.remoteHead || null,
    protected: syncState === "protected",
    warm: client.warm,
    meta: state.meta || null,
  }
  if (launchReady && launchTarget) {
    payload.launch = {
      directory: encodeDir(launchTarget.directory),
      sessionID: launchTarget.id,
      client: client.id,
    }
  }
  return payload
}

function handleEvents(ctx, req, res) {
  const { target, state } = ctx
  if (!target || !state) {
    json(res, 400, { error: "Invalid target host or port" })
    return
  }
  res.writeHead(200, runtimeHeaders({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  }))
  res.write(`event: hello\ndata: ${JSON.stringify({ target, offline: state.offline })}\n\n`)
  const unsubscribe = subscribeTarget(target, (message) => {
    res.write(`event: ${message.event}\ndata: ${JSON.stringify(message.payload)}\n\n`)
  })
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return
    res.write(": keepalive\n\n")
  }, 15000)
  heartbeat.unref?.()
  const cleanup = () => {
    clearInterval(heartbeat)
    unsubscribe()
  }
  req.on("close", cleanup)
  res.on("close", cleanup)
}

function healthPayload(states) {
  const { syncClients } = require("../warm")
  const summary = [...states.values()].map((state) => {
    syncClients(state)
    state.admission = targetAdmission(state)
    const staleClients = [...state.clients.values()].filter((client) => client.syncState === "stale").length
    const protectedClients = [...state.clients.values()].filter((client) => syncAction(state, client) === "defer").length
    const trackedAll = [...state.clients.values()]
      .map((client) => client.view || (client.activeSessionID && client.activeDirectory ? { sessionID: client.activeSessionID, directory: client.activeDirectory } : null))
      .filter(Boolean)
    const tracked = trackedAll
      .slice(0, 5)
      .map((view) => ({ sessionID: view.sessionID, directory: view.directory }))
    const messageEntries = [...state.messages.values()]
    const bySource = messageEntries.reduce((acc, entry) => {
      const key = String(entry?.source || "unknown")
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
    const oldestMessageAgeMs = messageEntries.length
      ? Math.max(...messageEntries.map((entry) => entry?.at ? Math.max(0, Date.now() - entry.at) : 0))
      : 0
    const effectiveStatus = state.meta?.ready && !state.failureReason && !state.lastError
      ? "ready"
      : state.targetStatus
    const payload = {
      target: state.target,
      targetType: state.targetType,
      targetStatus: effectiveStatus,
      admission: state.admission,
      availabilityAt: state.availabilityAt,
      failureReason: state.failureReason,
      failureCount: state.failureCount,
      backoffUntil: state.backoffUntil,
      launchReady: Boolean(state.meta?.ready && state.enterReady && state.enterReadySessionID === state.meta?.sessions?.latest?.id && state.enterReadyDirectory === state.meta?.sessions?.latest?.directory),
      enterReadyReason: state.enterReadyReason,
      refreshing: warmBusy(state),
      snapshotCount: Math.max(0, ...[...state.clients.values()].map((c) => c.warm.snapshotCount || 0)),
      cachedAt: state.meta?.cache?.cachedAt || 0,
      lastAccessAt: state.lastAccessAt,
      promiseActive: Boolean(state.promise),
      promiseAgeMs: state.promiseStartedAt ? Math.max(0, Date.now() - state.promiseStartedAt) : 0,
      heavyActive: state.heavyActive,
      heavyQueued: state.heavyQueue.length + state.heavyBackgroundQueue.length,
      heavyBackgroundActive: state.heavyBackgroundActive,
      heavyBackgroundQueued: state.heavyBackgroundQueue.length,
      backgroundActive: state.backgroundActive,
      backgroundQueued: state.backgroundQueue.length,
      backgroundKeys: state.backgroundKeys.size,
      backgroundWarmPaused: backgroundWarmPaused(state),
      offline: state.offline,
      offlineReason: state.offlineReason,
      resumeSafeClients: [...state.clients.values()].filter((c) => clientSafeMode(c)).length,
      ptyActive: state.ptyActive,
      clients: state.clients.size,
      staleClients,
      protectedClients,
      schedulerMode: state.schedulerMode,
      overloadSince: state.overloadSince,
      recoveringSince: state.recoveringSince,
      overloadReason: state.lastOverloadReason,
      warmStage: state.promise ? "connect" : "ready",
      stats: state.stats,
      lastReason: state.lastReason,
      lastReasonClient: state.lastReasonClient,
      lastError: state.lastError,
    }
    if (state.config?.healthzDebug) {
      payload.debug = {
        trackedSessionsCount: trackedAll.length,
        trackedSessionsSample: tracked,
        messageEntries: messageEntries.length,
        messageEntriesBySource: bySource,
        oldestMessageAgeMs,
        diskMessageEntries: bySource.disk || 0,
      }
    }
    return payload
  })
  return {
    ok: true,
    release: versionInfo,
    targets: summary.length,
    states: summary,
  }
}

function livezPayload(states) {
  return {
    ok: true,
    release: versionInfo,
    targets: states.size,
    now: Date.now(),
  }
}

function readyzPayload(states) {
  const health = healthPayload(states)
  const notReady = health.states.filter((item) => {
    if (item.targetStatus === "offline" || item.lastError) return true
    if (!item.launchReady || item.admission !== "enter") return true
    if (item.schedulerMode === "overload") return true
    if (item.promiseActive && item.promiseAgeMs > 10000) return true
    return false
  })
  return {
    ok: notReady.length === 0,
    release: versionInfo,
    targets: health.targets,
    notReady,
  }
}

function modezPayload(states) {
  return {
    ok: true,
    release: versionInfo,
    targets: [...states.values()].map((state) => ({
      target: state.target,
      targetType: state.targetType,
      targetStatus: state.targetStatus,
      admission: state.admission,
      schedulerMode: state.schedulerMode,
      backgroundWarmPaused: backgroundWarmPaused(state),
      offline: state.offline,
    })),
  }
}

async function resolveLaunch(state, client, snapshotCount, config) {
  const current = progressPayload(state, client)
  if (current.launchReady && current.launch) return current
  const { launchRedirectWaitMs, fastLaunchRedirectWaitMs } = config || {}
  const delay = (backgroundWarmPaused(state) || clientSafeMode(client))
    ? (launchRedirectWaitMs || 1200)
    : (fastLaunchRedirectWaitMs || 250)
  try {
    await Promise.race([
      warm(state, client, false, { snapshotCount }, config),
      new Promise((resolve) => setTimeout(resolve, delay)),
    ])
  } catch {}
  return progressPayload(state, client)
}

function handleControl(ctx, req, res, states) {
  const { state, client, target, wantCookie, config, reqUrl } = ctx

  if (ctx.controlRoute === "/clear") {
    clearTargetCookie(res)
    json(res, 200, { ok: true })
    return
  }

  if (ctx.controlRoute === "/healthz") {
    json(res, 200, healthPayload(states), relayHeaders("foreground", "control", "healthz"))
    return
  }

  if (ctx.controlRoute === "/livez") {
    json(res, 200, livezPayload(states), relayHeaders("foreground", "control", "livez"))
    return
  }

  if (ctx.controlRoute === "/readyz") {
    const payload = readyzPayload(states)
    json(res, payload.ok ? 200 : 503, payload, relayHeaders("foreground", "control", "readyz"))
    return
  }

  if (ctx.controlRoute === "/modez") {
    json(res, 200, modezPayload(states), relayHeaders("foreground", "control", "modez"))
    return
  }

  if (ctx.controlRoute === "/events") {
    handleEvents(ctx, req, res)
    return
  }

  if (!target || !state || !client) {
    json(res, 400, { error: "Invalid target host or port" })
    return
  }

  const snapshotCount = ctx.isMobile ? (config.mobileWarmSessionCount || 1) : (config.desktopWarmSessionCount || 2)

  if (ctx.controlRoute === "/progress") {
    try {
      const sessionID = reqUrl.searchParams.get("sessionID")
      const directory = reqUrl.searchParams.get("directory")
      const allowOverride = Boolean(config.enableProgressQueryOverride)
      const override = allowOverride && sessionID && directory
      if (override) {
        setClientView(client, { sessionID, directory, pathname: null })
      }
      clearLastReason(state, client)
      const cookieHeader = wantCookie ? { "Set-Cookie": `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax` } : undefined
      json(
        res,
        200,
        progressPayload(state, client),
        withRelay(
          {
            ...(cookieHeader || {}),
            "X-OC-Progress-Override": override ? "applied" : (sessionID || directory ? "ignored" : "none"),
          },
          "foreground",
          "control",
          clientSafeMode(client) ? "resume-safe-progress" : "progress",
        ),
      )
    } catch (err) {
      setLastReason(state, client, "warm-failed")
      json(res, 502, { error: classifyError(err, "Warm failed") }, relayHeaders("foreground", "error", "warm-failed"))
    }
    return
  }

  if (ctx.controlRoute === "/meta") {
    const run = async () => {
      try {
        const meta = state.meta && state.meta.ready ? metaEnvelope(state) : await warm(state, client, false, { snapshotCount }, config)
        refresh(state, client, config)
        clearLastReason(state, client)
        const cookieHeader = wantCookie ? { "Set-Cookie": `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax` } : undefined
        json(res, 200, meta, withRelay(cookieHeader, "foreground", "control", clientSafeMode(client) ? "resume-safe-meta" : "meta"))
      } catch (err) {
        setLastReason(state, client, "target-inspection-failed")
        state.offline = true
        state.offlineReason = classifyError(err, "Target inspection failed")
        state.failureReason = state.offlineReason
        state.targetStatus = "offline"
        state.admission = targetAdmission(state)
        json(res, 200, metaEnvelope(state), relayHeaders("foreground", "fallback", "target-inspection-failed"))
      }
    }
    run()
    return
  }

  if (ctx.controlRoute === "/launch") {
    const run = async () => {
      const payload = await resolveLaunch(state, client, snapshotCount, config)
      if (wantCookie) setTargetCookie(res, target)
      clearLastReason(state, client)
      res.writeHead(200, withRelay(
        { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        "foreground", "control",
        payload.resumeSafeMode ? "resume-safe-launch-page" : payload.launchReady ? "launch-gate-ready" : "launch-gate",
      ))
      res.end(launchPage(target, client.id, payload, config))
    }
    run()
    return
  }

  json(res, 404, { error: "Unknown control route" })
}

module.exports = {
  handleControl,
  setTargetCookie,
  clearTargetCookie,
  progressPayload,
  healthPayload,
  livezPayload,
  readyzPayload,
  modezPayload,
  resolveLaunch,
  handleEvents,
}
