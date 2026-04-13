"use strict"

const http = require("http")
const { now, fresh, classifyError, cacheKey, dirKey } = require("./util")
const { setWarm, warmBusy, setLastReason, backgroundWarmPaused, clientSafeMode, touchState, targetAdmission } = require("./state")
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

function upstreamAuth() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return null
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
}

function requestText(target, path, headers, config) {
  const cfg = config || defaults
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const base = headers || { Accept: "application/json" }
    const auth = upstreamAuth()
    if (auth && !base.Authorization && !base.authorization) base.Authorization = auth
    const req = http.request(
      {
        hostname: target.host,
        port: Number(target.port),
        path,
        method: "GET",
        headers: base,
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

function projectRoots(projects) {
  const seen = new Set()
  const roots = []
  for (const item of Array.isArray(projects) ? projects : []) {
    const dir = item?.worktree
    const key = dirKey(dir)
    if (!dir || seen.has(key)) continue
    seen.add(key)
    roots.push(dir)
  }
  return roots
}

function sessionStamp(item) {
  return item?.time?.updated ?? item?.time?.created ?? 0
}

function sortSessions(list) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => sessionStamp(b) - sessionStamp(a))
}

function sessionRowKey(row) {
  return `${dirKey(row?.directory)}\n${row?.id || ""}`
}

function mergeSessionRows(primary, secondary, limit) {
  const seen = new Set()
  const rows = []
  for (const row of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    const key = sessionRowKey(row)
    if (!row?.directory || !row?.id || seen.has(key)) continue
    seen.add(key)
    rows.push(row)
    if (limit && rows.length >= limit) break
  }
  return rows
}

function resolveWorkspaceRoot(projects, directory) {
  if (!directory) return ""
  const direct = (Array.isArray(projects) ? projects : []).find((item) => dirKey(item?.worktree) === dirKey(directory))
  if (direct?.worktree) return direct.worktree
  const sandbox = (Array.isArray(projects) ? projects : []).find((item) => Array.isArray(item?.sandboxes) && item.sandboxes.some((entry) => dirKey(entry) === dirKey(directory)))
  return sandbox?.worktree || directory
}

function buildWorkspaceRoots(inventory, sessionList, extraRoots) {
  const seen = new Set()
  const roots = []
  const add = (directory) => {
    const key = dirKey(directory)
    if (!directory || seen.has(key)) return
    seen.add(key)
    roots.push(directory)
  }
  projectRoots(inventory).forEach(add)
  for (const row of Array.isArray(sessionList) ? sessionList : []) add(resolveWorkspaceRoot(inventory, row?.directory))
  for (const dir of Array.isArray(extraRoots) ? extraRoots : []) add(dir)
  return roots
}

function projectInventory(projects, roots) {
  const list = Array.isArray(projects) ? projects.slice() : []
  const seen = new Set(projectRoots(list).map((dir) => dirKey(dir)))
  for (const dir of Array.isArray(roots) ? roots : []) {
    const key = dirKey(dir)
    if (!dir || seen.has(key)) continue
    seen.add(key)
    list.push({
      id: `relay:${Buffer.from(dir, "utf8").toString("base64").replace(/=+$/g, "")}`,
      worktree: dir,
      sandboxes: [],
    })
  }
  return list
}

function workspaceSessionEntry(workspaceSessions, directory) {
  return workspaceSessions?.get(dirKey(directory)) || null
}

function workspaceSessionRows(root, projects, workspaceSessions, fallbackList) {
  const entry = workspaceSessionEntry(workspaceSessions, root)
  if (entry) return sortSessions(entry.items)
  return sortSessions((Array.isArray(fallbackList) ? fallbackList : []).filter((row) => dirKey(resolveWorkspaceRoot(projects, row?.directory)) === dirKey(root)))
}

function buildSessionIndex(roots, projects, workspaceSessions, fallbackList, limit) {
  const rows = []
  for (const root of Array.isArray(roots) ? roots : []) rows.push(...workspaceSessionRows(root, projects, workspaceSessions, fallbackList))
  const merged = sortSessions(mergeSessionRows(sortSessions(rows), [], 0))
  return typeof limit === "number" && limit > 0 ? merged.slice(0, limit) : merged
}

function latestByRoot(roots, projects, workspaceSessions, fallbackList) {
  const map = {}
  for (const root of Array.isArray(roots) ? roots : []) {
    const item = workspaceSessionRows(root, projects, workspaceSessions, fallbackList)[0]
    if (!item?.id || !item?.directory) continue
    map[root] = { directory: item.directory, id: item.id, at: now() }
  }
  return map
}

function buildMeta(target, health, list, projects, workspaceSessions, latencyMs, config) {
  const cfg = config || defaults
  const raw = Array.isArray(projects) ? projects : []
  const realInventory = raw.filter((item) => item && !String(item.id || "").startsWith("relay:"))
  const roots = buildWorkspaceRoots(realInventory, list, cfg.extraRoots)
  const inventory = projectInventory(realInventory, roots)
  const sessionIndex = buildSessionIndex(roots, realInventory, workspaceSessions, list, cfg.maxSessions)
  const root = sessionIndex[0] || null
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
      count: sessionIndex.length,
      directories: roots,
      latest: root
        ? { id: root.id || null, title: root.title || null, directory: root.directory || null }
        : null,
      error: root ? null : "Target is online but has no historical sessions",
    },
    projects: {
      count: inventory.length,
      roots,
      inventory,
      lastProjectSession: latestByRoot(roots, realInventory, workspaceSessions, list),
    },
    ready: Boolean(health?.healthy === true && root?.id && root?.directory),
    cache: { source: "router", cachedAt: now(), warm: true },
  }
}

function metaEnvelope(state) {
  const base = state.meta || {
    target: state.target,
    source: { kind: "cli", label: "Global CLI service" },
    health: {
      ok: false,
      healthy: false,
      version: null,
      latencyMs: null,
      error: state.failureReason || state.offlineReason || "Target inspection failed",
    },
    sessions: {
      ok: false,
      count: 0,
      directories: [],
      latest: null,
      error: state.failureReason || state.offlineReason || "Target inspection failed",
    },
    projects: {
      count: 0,
      roots: [],
      inventory: [],
      lastProjectSession: {},
    },
    ready: false,
    cache: { source: "router", cachedAt: now(), warm: false },
  }
  const fallbackRoots = base.sessions?.directories || []
  const raw = Array.isArray(state.inventory) ? state.inventory : []
  const realInventory = raw.filter((item) => item && !String(item.id || "").startsWith("relay:"))
  const built = buildWorkspaceRoots(realInventory, state.sessionList, state.config?.extraRoots)
  const roots = built.length ? built : fallbackRoots
  const inventory = projectInventory(realInventory, roots)
  const currentProjects = {
    count: inventory.length,
    roots,
    inventory,
    lastProjectSession: latestByRoot(roots, realInventory, state.workspaceSessions, state.sessionList),
  }
  return {
    ...base,
    projects: inventory.length ? currentProjects : (base.projects || currentProjects),
    targetType: state.targetType,
    targetStatus: state.targetStatus,
    admission: state.admission,
    availabilityAt: state.availabilityAt,
    failureReason: state.failureReason,
    failureCount: state.failureCount,
    backoffUntil: state.backoffUntil,
  }
}

function buildList(list, directory, limit) {
  return sortSessions(list.filter((item) => item?.directory === directory)).slice(0, limit)
}

function rememberList(state, directory, limit, list, at) {
  const rows = Array.isArray(list) ? sortSessions(list).slice(0, limit) : buildList(state.sessionList, directory, limit)
  const text = JSON.stringify(rows)
  state.lists.set(`${directory}\n${limit}`, { body: text, type: "application/json", status: 200, at: at || now() })
}

function rememberWorkspaceSessions(state, directory, list, requestedLimit, config, at) {
  const stamp = at || now()
  const rows = sortSessions(Array.isArray(list) ? list : [])
  const prev = workspaceSessionEntry(state.workspaceSessions, directory)
  const authoritativeLimit = Math.max(Number(requestedLimit || rows.length || 0), Number(prev?.limit || 0))
  const items = !rows.length
    ? []
    : mergeSessionRows(rows, prev?.items || [], authoritativeLimit || rows.length)
  const entry = {
    directory,
    items,
    limit: authoritativeLimit || items.length,
    at: stamp,
  }
  state.workspaceSessions.set(dirKey(directory), entry)
  rememberList(state, directory, 55, entry.items, stamp)
  if (entry.limit && entry.limit !== 55) rememberList(state, directory, entry.limit, entry.items, stamp)
  return entry
}

function workspaceListForLimit(state, directory, limit) {
  const cached = state.lists.get(`${directory}\n${limit}`)
  if (cached) return cached
  const entry = workspaceSessionEntry(state.workspaceSessions, directory)
  if (!entry) return null
  const requestedLimit = Number(limit || 0)
  const exhausted = entry.items.length < entry.limit
  if (requestedLimit > entry.limit && !exhausted) return null
  const synthesized = {
    body: JSON.stringify(entry.items.slice(0, requestedLimit || entry.items.length)),
    type: "application/json",
    status: 200,
    at: entry.at,
  }
  state.lists.set(`${directory}\n${limit}`, synthesized)
  return synthesized
}

async function fetchWorkspaceRoot(state, target, directory, config) {
  const cfg = config || defaults
  const limit = Number(cfg.directoryDiscoveryLimit || cfg.maxSessions || defaults.maxSessions)
  const path = `/session?directory=${encodeURIComponent(directory)}&roots=true&limit=${limit}`
  const data = await fetchJsonWith(target, path, { heavy: true, state }, config)
  const rows = Array.isArray(data.data) ? data.data : []
  rememberWorkspaceSessions(state, directory, rows, limit, config, now())
  return rows
}

async function fetchAllWorkspaceRoots(state, target, config) {
  const cfg = config || {}
  const roots = buildWorkspaceRoots(state.inventory, state.sessionList, cfg.extraRoots)
  await Promise.all(roots.map(async (directory) => {
    try {
      await fetchWorkspaceRoot(state, target, directory, config)
    } catch {
      const fallback = state.sessionList.filter((item) => dirKey(resolveWorkspaceRoot(state.inventory, item?.directory)) === dirKey(directory))
      if (fallback.length) rememberWorkspaceSessions(state, directory, fallback, fallback.length, config, now())
    }
  }))
  return roots
}


async function cacheMessages(state, target, directory, sessionID, limit, config) {
  const path = `/session/${encodeURIComponent(sessionID)}/message?limit=${limit}&directory=${encodeURIComponent(directory)}`
  const cfg = config || defaults
  const maxHeavy = cfg.maxHeavyRequestsPerTarget || 2
  const maxBg = Math.max(1, maxHeavy - 1)
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

async function cacheProjectCurrent(state, target, directory, config) {
  const path = `/project/current?directory=${encodeURIComponent(directory)}`
  const data = await fetchJsonWith(target, path, { state }, config)
  state.projects.set(directory, {
    body: data.text,
    type: "application/json",
    status: 200,
    at: now(),
  })
  saveStateCache(state, config)
}


async function cacheShellHtml(state, target, config) {
  const data = await requestText(target, '/', { Accept: 'text/html', 'accept-encoding': 'identity', Connection: 'close' }, config)
  state.shellHtml = {
    body: data.text,
    type: 'text/html; charset=utf-8',
    status: 200,
    at: now(),
  }
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
  state.failureReason = message
  state.targetStatus = state.offline ? "offline" : "error"
  state.failureCount += 1
  state.lastFailureAt = now()
  state.backoffUntil = state.meta ? now() + Math.min(15000, state.failureCount * 2000) : 0
  state.admission = targetAdmission(state)
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
  if (!fresh(state.shellHtml?.at, cfg.snapshotCacheMs)) {
    jobs.push({
      key: 'shell-html',
      run: async () => {
        setWarm(client, {
          active: true,
          ready: true,
          percent: 54,
          stage: 'snapshot',
          note: 'Caching app shell on the VPS...',
        })
        await cacheShellHtml(state, target, config)
      },
    })
  }
  if (needsDetail) {
    jobs.push({
      key: `detail\n${latestSession.directory}\n${latestSession.id}`,
      run: async () => {
        setWarm(client, {
          active: true, ready: true, percent: 60, stage: "snapshot",
          note: "Caching latest session detail in the background...",
        })
        await cacheDetail(state, target, latestSession.directory, latestSession.id, config)
      },
    })
  }
  if (!fresh(state.projects.get(latestSession.directory)?.at, cfg.snapshotCacheMs)) {
    jobs.push({
      key: `project\n${latestSession.directory}`,
      run: async () => {
        setWarm(client, {
          active: true,
          ready: true,
          percent: 58,
          stage: "snapshot",
          note: "Caching current project context in the background...",
        })
        await cacheProjectCurrent(state, target, latestSession.directory, config)
      },
    })
  }
  messageJobs.forEach(({ item, limit }, index) => {
    jobs.push({
      key: `message\n${item.directory}\n${item.id}\n${limit}`,
      run: async () => {
        setWarm(client, {
          active: true, ready: true,
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
      active: false, ready: true, percent: 100, stage: "ready",
      note: "Background cache is already warm.", cachedAt: now(), snapshotCount: nearby.length,
    })
    return
  }
  setWarm(client, {
    active: true, ready: true, percent: 55, stage: "snapshot",
    note: `Caching ${jobs.length + pending} recent session tasks in the background...`,
    latestSessionID: latestSession.id, latestDirectory: latestSession.directory, snapshotCount: nearby.length,
  })
  let queued = 0
  jobs.forEach((job) => { if (enqueueBackground(state, job.key, job.run)) queued += 1 })
  if (!queued && pending) {
    setWarm(client, {
      active: true, ready: true, percent: 55, stage: "snapshot",
      note: "Background cache is already queued.",
      latestSessionID: latestSession.id, latestDirectory: latestSession.directory, snapshotCount: nearby.length,
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
      active: true, ready: Boolean(state.meta?.ready),
      percent: client.warm.percent || 5,
      stage: client.warm.stage === "idle" ? "connect" : client.warm.stage,
      note: state.meta ? "Refreshing cached state..." : "First read may take longer while the VPS builds a cache.",
      error: null,
    })
    return state.promise
  }
  if (!force && fresh(state.metaAt, cfg.metaCacheMs) && state.meta) return Promise.resolve(state.meta)
  if (!force && state.backoffUntil && state.backoffUntil > now() && state.meta) return Promise.resolve(state.meta)
  const target = state.target
  const body = async () => {
    setWarm(client, {
      active: true, ready: false, percent: 5, stage: "connect",
      note: state.meta ? "Refreshing cached state..." : "First read may take longer while the VPS builds a cache.",
      error: null,
    })
    let health
    try {
      health = await fetchJson(target, "/global/health", config)
      state.offline = false
      state.offlineReason = null
      state.targetStatus = health.data?.healthy === true ? "healthy" : "unhealthy"
      state.failureReason = null
      state.availabilityAt = now()
    } catch (err) {
      state.offline = true
      state.offlineReason = err.message
      if (failWarm(state, client, err, "Health check failed")) throw err
      return metaEnvelope(state)
    }
    setWarm(client, { percent: 28, stage: "index", note: "Reading remote session index..." })
    let sessions
    try {
      sessions = await fetchJsonWith(target, `/session?limit=${cfg.directoryDiscoveryLimit || cfg.maxSessions}`, { heavy: true, state }, config)
      state.offline = false
      state.offlineReason = null
      state.targetStatus = "healthy"
      state.failureReason = null
      state.availabilityAt = now()
    } catch (err) {
      state.offline = true
      state.offlineReason = err.message
      if (failWarm(state, client, err, "Session scan failed")) throw err
      return metaEnvelope(state)
    }
    let inventory = []
    try {
      const projects = await fetchJsonWith(target, "/project", { state }, config)
      inventory = Array.isArray(projects.data) ? projects.data : []
    } catch {}
    const discoveryList = Array.isArray(sessions.data) ? sessions.data : []
    inventory = projectInventory(inventory, buildWorkspaceRoots(inventory, discoveryList, cfg.extraRoots))
    state.inventory = inventory
    state.inventoryAt = now()
    state.config = cfg
    state.sessionList = discoveryList

    // FAST-PATH: build meta from DISCOVERY list only — do NOT wait for fetchAllWorkspaceRoots.
    // compute latest from discoveryList using session time order (newest first)
    const discoveryIndex = sortSessions(discoveryList)
    const latestFromDiscovery = discoveryIndex[0] || null
    const fastMetaReady = Boolean(health?.healthy === true && latestFromDiscovery?.id && latestFromDiscovery?.directory)
    const fastInventory = (Array.isArray(inventory) ? inventory : []).filter(item => item && !String(item.id || "").startsWith("relay:"))
    const fastRoots = buildWorkspaceRoots(fastInventory, discoveryList, cfg.extraRoots)
    const fastMeta = buildMeta(target, health.data, discoveryList, fastInventory, new Map(), health.latencyMs, cfg)
    state.meta = fastMeta
    state.metaAt = now()
    state.targetStatus = fastMetaReady ? "ready" : "no-session"
    state.failureReason = fastMetaReady ? null : fastMeta.sessions.error || "No restoreable session found"
    state.admission = targetAdmission(state)
    if (fastMetaReady) {
      state.failureCount = 0
      state.backoffUntil = 0
      state.availabilityAt = now()
    }
    saveStateCache(state, config)
    if (fastMetaReady) {
      const latestSession = fastMeta.sessions.latest
      const nearby = discoveryList
        .filter((item) => item?.directory === latestSession?.directory)
        .slice(0, health.latencyMs >= cfg.slowHealthLatencyMs ? 0 : requestedSnapshotCount)
      setWarm(client, {
        active: false, ready: true, first: false, percent: 100, stage: "ready",
        note: health.latencyMs >= cfg.slowHealthLatencyMs
          ? "Upstream is slow. Opening now and background caching remaining workspaces..."
          : client.warm.first
            ? "Cache index is ready. Opening the latest session..."
            : "Latest session is ready. Opening now...",
        cachedAt: now(), latestSessionID: latestSession?.id, latestDirectory: latestSession?.directory, error: null,
      })
      scheduleSnapshotWarm(state, client, target, latestSession, nearby, config)
      state.meta.cache = { source: "router", cachedAt: now(), warm: true }
    } else {
      setWarm(client, {
        active: false, ready: false, percent: 100, stage: "done",
        note: fastMeta.sessions.error || "No restoreable session found", cachedAt: state.metaAt,
      })
    }
    saveStateCache(state, config)

    // BACKGROUND: fill workspaceSessions for all roots — does NOT block the fast return
    void fetchAllWorkspaceRoots(state, target, cfg).then(() => {
      // after background workspace roots load, rebuild sessionIndex and meta with full workspaceSessions
      if (!state.meta?.ready) return
      const fullRoots = buildWorkspaceRoots(fastInventory, discoveryList, cfg.extraRoots)
      state.sessionList = buildSessionIndex(fullRoots, fastInventory, state.workspaceSessions, discoveryList, cfg.maxSessions)
      state.meta = buildMeta(target, health.data, discoveryList, fastInventory, state.workspaceSessions, health.latencyMs, cfg)
      state.meta.cache = { source: "router", cachedAt: now(), warm: true }
      saveStateCache(state, cfg)
    }).catch(() => {})

    return metaEnvelope(state)
  }
  const run = Promise.race([
    body(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Warm timed out after ${cfg.warmTimeoutMs}ms`)), cfg.warmTimeoutMs)),
  ])
    .catch((err) => {
      if (failWarm(state, client, err, "Warm refresh failed")) throw err
      return metaEnvelope(state)
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
  buildWorkspaceRoots,
  projectInventory,
  buildSessionIndex,
  buildMeta,
  metaEnvelope,
  buildList,
  rememberList,
  rememberWorkspaceSessions,
  workspaceListForLimit,
  fetchWorkspaceRoot,
  fetchAllWorkspaceRoots,
  cacheMessages,
  cacheDetail,
  cacheProjectCurrent,
  cacheShellHtml,
  snapshotGoal,
  settleWarm,
  failWarm,
  syncWarm,
  syncClients,
  scheduleSnapshotWarm,
  warm,
  refresh,
}
