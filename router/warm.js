"use strict"

const http = require("http")
const { now, fresh, uniqueDirectories, classifyError, cacheKey } = require("./util")
const { setWarm, warmBusy, setLastReason, touchState } = require("./state")
const { runHeavy, enqueueBackground } = require("./heavy")
const { saveStateCache } = require("./sync/disk-cache")

const defaults = {
  inspectTimeoutMs: 5000,
  warmTimeoutMs: 7000,
  metaCacheMs: 15000,
  snapshotCacheMs: 45000,
  slowHealthLatencyMs: 1500,
  maxSessions: 80,
  maxProjects: 12,
  desktopWarmSessionCount: 2,
  mobileWarmSessionCount: 1,
  maxHeavyRequestsPerTarget: 2,
  launchRedirectWaitMs: 1200,
  fastLaunchRedirectWaitMs: 250,
}

let upstreamAgent

function getAgent() {
  if (!upstreamAgent) {
    upstreamAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 30000,
      maxSockets: 16,
      maxFreeSockets: 8,
    })
  }
  return upstreamAgent
}

function requestText(target, path, headers, config) {
  const cfg = config || defaults
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const req = http.request(
      {
        hostname: target.host,
        port: Number(target.port),
        path,
        method: "GET",
        headers: headers || { Accept: "application/json" },
        agent: getAgent(),
      },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          if ((res.statusCode || 500) >= 400) {
            reject(new Error(`Upstream returned ${res.statusCode || 500}`))
            return
          }
          resolve({ body, latencyMs: Date.now() - start, headers: res.headers })
        })
      },
    )
    req.setTimeout(cfg.inspectTimeoutMs, () => {
      req.destroy(new Error(`Timed out after ${cfg.inspectTimeoutMs}ms`))
    })
    req.on("error", reject)
    req.end()
  })
}

async function fetchJson(target, path, config) {
  return fetchJsonWith(target, path, {}, config)
}

async function fetchJsonWith(target, path, options, config) {
  const opts = options || {}
  if (opts.state) {
    opts.state.stats.upstreamFetch += 1
    touchState(opts.state)
  }
  const exec = () => requestText(target, path, opts.headers, config)
  const cfg = config || defaults
  const maxHeavy = cfg.maxHeavyRequestsPerTarget || 2
  const maxBg = Math.max(1, maxHeavy - 1)
  const res = opts.heavy && opts.state ? await runHeavy(opts.state, exec, opts.priority, maxHeavy, maxBg) : await exec()
  return {
    data: res.body ? JSON.parse(res.body) : null,
    text: res.body,
    latencyMs: res.latencyMs,
    headers: res.headers,
  }
}

function buildMeta(target, health, list, latencyMs, config) {
  const cfg = config || defaults
  const { latest } = require("./util")
  const root = latest(list)
  return {
    target,
    source: { kind: "cli", label: "Global CLI service" },
    health: {
      ok: true,
      healthy: health?.healthy === true,
      version: health?.version || null,
      latencyMs,
      error: health?.healthy === true ? null : "OpenCode unhealthy",
    },
    sessions: {
      ok: true,
      count: list.length,
      directories: uniqueDirectories(list, cfg.maxProjects),
      latest: root
        ? { id: root.id || null, title: root.title || null, directory: root.directory || null }
        : null,
      error: list.length ? null : "Target is online but has no historical sessions",
    },
    ready: Boolean(health?.healthy === true && root?.id && root?.directory),
    cache: { source: "router", cachedAt: now(), warm: true },
  }
}

function buildList(list, directory, limit) {
  return list.filter((item) => item?.directory === directory).slice(0, limit)
}

function rememberList(state, directory, limit) {
  const text = JSON.stringify(buildList(state.sessionList, directory, limit))
  state.lists.set(`${directory}\n${limit}`, { body: text, type: "application/json", at: now() })
}

async function cacheMessages(state, target, directory, sessionID, limit, config) {
  const path = `/session/${encodeURIComponent(sessionID)}/message?limit=${limit}&directory=${encodeURIComponent(directory)}`
  const data = await fetchJsonWith(target, path, { heavy: true, state }, config)
  state.messages.set(cacheKey(directory, sessionID, limit), {
    body: data.text,
    type: "application/json",
    at: now(),
    sessionID,
    directory,
    limit,
  })
  saveStateCache(state, config)
}

async function cacheDetail(state, target, directory, sessionID, config) {
  const path = `/session/${encodeURIComponent(sessionID)}?directory=${encodeURIComponent(directory)}`
  const data = await fetchJsonWith(target, path, { heavy: true, state }, config)
  state.details.set(`${directory}\n${sessionID}`, {
    body: data.text,
    type: "application/json",
    at: now(),
  })
  saveStateCache(state, config)
}

function snapshotGoal(state, requested) {
  const latestDir = state.meta?.sessions?.latest?.directory
  if (!latestDir) return requested
  const available = state.sessionList.filter((item) => item?.directory === latestDir).length
  if (!available) return requested
  return Math.max(1, Math.min(requested, available))
}

function settleWarm(state, client, note) {
  if (warmBusy(state)) return
  const ready = Boolean(state.meta?.ready)
  setWarm(client, {
    active: false,
    ready,
    first: false,
    percent: ready ? 100 : client.warm.percent,
    stage: ready ? "ready" : client.warm.stage,
    note: note || (ready ? "Background cache is ready." : client.warm.note),
    cachedAt: ready ? now() : client.warm.cachedAt,
  })
}

function failWarm(state, client, err, fallback) {
  const message = classifyError(err, fallback)
  state.lastError = message
  setLastReason(state, client, fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-"))
  client.lastError = message
  if (state.meta?.ready) {
    state.stats.staleLaunch += 1
    setWarm(client, {
      active: false,
      ready: true,
      first: false,
      percent: 100,
      stage: "ready",
      note: "Using cached session metadata while refresh failed.",
      cachedAt: client.warm.cachedAt || state.metaAt || now(),
      error: message,
    })
    return false
  }
  setWarm(client, {
    active: false,
    ready: false,
    percent: 100,
    stage: "error",
    note: message,
    error: message,
  })
  return true
}

function syncWarm(state, client) {
  if (!client.warm.active) return
  if (warmBusy(state)) return
  settleWarm(state, client, client.warm.error && state.meta?.ready ? "Using cached session metadata while refresh failed." : undefined)
}

function syncClients(state) {
  for (const client of state.clients.values()) syncWarm(state, client)
}

function scheduleSnapshotWarm(state, client, target, latestSession, nearby, config) {
  const cfg = config || defaults
  if (!latestSession?.directory || !latestSession?.id) return
  const detailKey = `${latestSession.directory}\n${latestSession.id}`
  const needsDetail = !fresh(state.details.get(detailKey)?.at, cfg.snapshotCacheMs)
  const messageJobs = nearby
    .map((item) => ({ item, limit: item.id === latestSession.id ? 80 : 200 }))
    .filter(({ item, limit }) => !fresh(state.messages.get(cacheKey(item.directory, item.id, limit))?.at, cfg.snapshotCacheMs))
  const jobs = []
  if (needsDetail) {
    jobs.push({
      key: `detail\n${latestSession.directory}\n${latestSession.id}`,
      run: async () => {
        setWarm(client, {
          active: true,
          ready: true,
          percent: 60,
          stage: "snapshot",
          note: "Caching latest session detail in the background...",
        })
        await cacheDetail(state, target, latestSession.directory, latestSession.id, config)
      },
    })
  }
  messageJobs.forEach(({ item, limit }, index) => {
    jobs.push({
      key: `message\n${item.directory}\n${item.id}\n${limit}`,
      run: async () => {
        setWarm(client, {
          active: true,
          ready: true,
          percent: 65 + Math.round(((index + 1) / Math.max(messageJobs.length, 1)) * 30),
          stage: "snapshot",
          note: `Caching session ${index + 1}/${Math.max(messageJobs.length, 1)} in the background...`,
        })
        await cacheMessages(state, target, item.directory, item.id, limit, config)
      },
    })
  })
  const pending = jobs.filter((job) => state.backgroundKeys.has(job.key)).length
  if (!jobs.length && !pending) {
    setWarm(client, {
      active: false,
      ready: true,
      percent: 100,
      stage: "ready",
      note: "Background cache is already warm.",
      cachedAt: now(),
      snapshotCount: nearby.length,
    })
    return
  }
  setWarm(client, {
    active: true,
    ready: true,
    percent: 55,
    stage: "snapshot",
    note: `Caching ${jobs.length + pending} recent session tasks in the background...`,
    latestSessionID: latestSession.id,
    latestDirectory: latestSession.directory,
    snapshotCount: nearby.length,
  })
  let queued = 0
  jobs.forEach((job) => {
    if (enqueueBackground(state, job.key, job.run)) queued += 1
  })
  if (!queued && pending) {
    setWarm(client, {
      active: true,
      ready: true,
      percent: 55,
      stage: "snapshot",
      note: "Background cache is already queued.",
      latestSessionID: latestSession.id,
      latestDirectory: latestSession.directory,
      snapshotCount: nearby.length,
    })
    return
  }
  if (!queued) settleWarm(state, client)
}

async function warm(state, client, force, options, config) {
  const cfg = config || defaults
  const opts = options || {}
  const requestedSnapshotCount = opts.snapshotCount || cfg.desktopWarmSessionCount
  if (state.promise) {
    setWarm(client, {
      active: true,
      ready: Boolean(state.meta?.ready),
      percent: client.warm.percent || 5,
      stage: client.warm.stage === "idle" ? "connect" : client.warm.stage,
      note: state.meta ? "Refreshing cached state..." : "First read may take longer while the VPS builds a cache.",
      error: null,
    })
    return state.promise
  }
  if (!force && fresh(state.metaAt, cfg.metaCacheMs) && state.meta) return Promise.resolve(state.meta)
  const target = state.target
  const body = async () => {
    setWarm(client, {
      active: true,
      ready: false,
      percent: 5,
      stage: "connect",
      note: state.meta ? "Refreshing cached state..." : "First read may take longer while the VPS builds a cache.",
      error: null,
    })
    let health
    try {
      health = await fetchJson(target, "/global/health", config)
      state.offline = false
      state.offlineReason = null
    } catch (err) {
      state.offline = true
      state.offlineReason = err.message
      if (failWarm(state, client, err, "Health check failed")) throw err
      return state.meta
    }
    setWarm(client, { percent: 28, stage: "index", note: "Reading remote session index..." })
    let sessions
    try {
      sessions = await fetchJsonWith(target, `/session?limit=${cfg.maxSessions}`, { heavy: true, state }, config)
      state.offline = false
      state.offlineReason = null
    } catch (err) {
      state.offline = true
      state.offlineReason = err.message
      if (failWarm(state, client, err, "Session scan failed")) throw err
      return state.meta
    }
    state.sessionList = Array.isArray(sessions.data) ? sessions.data : []
    state.meta = buildMeta(target, health.data, state.sessionList, health.latencyMs, config)
    state.metaAt = now()
    for (const dir of uniqueDirectories(state.sessionList, cfg.maxProjects)) rememberList(state, dir, 55)
    saveStateCache(state, config)
    if (!state.meta.ready) {
      setWarm(client, {
        active: false,
        ready: false,
        percent: 100,
        stage: "done",
        note: state.meta.sessions.error || "No restoreable session found",
        cachedAt: state.metaAt,
      })
      return state.meta
    }
    const latestSession = state.meta.sessions.latest
    const nearby = state.sessionList
      .filter((item) => item?.directory === latestSession.directory)
      .slice(0, health.latencyMs >= cfg.slowHealthLatencyMs ? 0 : requestedSnapshotCount)
    setWarm(client, {
      active: false,
      ready: true,
      first: false,
      percent: 100,
      stage: "ready",
      note: health.latencyMs >= cfg.slowHealthLatencyMs
        ? "Upstream is slow. Opening now and reducing background cache work..."
        : client.warm.first
          ? "Cache index is ready. Opening the latest session..."
          : "Latest session is ready. Opening now...",
      cachedAt: now(),
      latestSessionID: latestSession.id,
      latestDirectory: latestSession.directory,
      error: null,
    })
    scheduleSnapshotWarm(state, client, target, latestSession, nearby, config)
    state.meta.cache = { source: "router", cachedAt: now(), warm: true }
    saveStateCache(state, config)
    return state.meta
  }
  const run = Promise.race([
    body(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Warm timed out after ${cfg.warmTimeoutMs}ms`)), cfg.warmTimeoutMs)),
  ])
    .catch((err) => {
      if (failWarm(state, client, err, "Warm refresh failed")) throw err
      return state.meta
    })
    .finally(() => {
      state.promise = undefined
      state.promiseStartedAt = 0
      syncClients(state)
    })
  state.promise = run
  state.promiseStartedAt = now()
  return run
}

function refresh(state, client, config) {
  const cfg = config || defaults
  if (state.promise) return
  if (!state.meta) return
  if (fresh(state.metaAt, cfg.metaCacheMs)) return
  const { ensureClientState, sharedClientID } = require("./state")
  const launch = client || ensureClientState(state, sharedClientID)
  void warm(state, launch, true, { snapshotCount: snapshotGoal(state, launch.warm.snapshotCount || cfg.desktopWarmSessionCount) }, config).catch(() => {})
}

module.exports = {
  defaults,
  getAgent,
  requestText,
  fetchJson,
  fetchJsonWith,
  buildMeta,
  buildList,
  rememberList,
  cacheMessages,
  cacheDetail,
  snapshotGoal,
  settleWarm,
  failWarm,
  syncWarm,
  syncClients,
  scheduleSnapshotWarm,
  warm,
  refresh,
}
