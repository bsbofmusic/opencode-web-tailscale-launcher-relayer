const http = require("http")

const bindHost = process.env.OPENCODE_ROUTER_HOST || "127.0.0.1"
const bindPort = Number(process.env.OPENCODE_ROUTER_PORT || "33102")
const targetCookie = "oc_target"
const sharedClientID = "_shared"
const maxSessions = 80
const maxProjects = 12
const inspectTimeoutMs = Number(process.env.OPENCODE_ROUTER_INSPECT_TIMEOUT_MS || "5000")
const warmTimeoutMs = Number(process.env.OPENCODE_ROUTER_WARM_TIMEOUT_MS || String(inspectTimeoutMs + 2000))
const htmlProxyTimeoutMs = Number(process.env.OPENCODE_ROUTER_HTML_TIMEOUT_MS || "8000")
const metaCacheMs = Number(process.env.OPENCODE_ROUTER_META_CACHE_MS || "15000")
const snapshotCacheMs = Number(process.env.OPENCODE_ROUTER_SNAPSHOT_CACHE_MS || "45000")
const desktopWarmSessionCount = 2
const mobileWarmSessionCount = 1
const maxHeavyRequestsPerTarget = 2
const maxTargets = 8
const targetIdleMs = 30 * 60 * 1000
const cleanupIntervalMs = 5 * 60 * 1000
const launchRedirectWaitMs = 1200
const slowHealthLatencyMs = Number(process.env.OPENCODE_ROUTER_SLOW_HEALTH_MS || "1500")
const maxBackgroundHeavyRequestsPerTarget = Math.max(1, maxHeavyRequestsPerTarget - 1)
const idleRecoveryThresholdMs = Number(process.env.OPENCODE_ROUTER_IDLE_RECOVERY_THRESHOLD_MS || "300000")
const idleRecoveryWindowMs = Number(process.env.OPENCODE_ROUTER_IDLE_RECOVERY_WINDOW_MS || "30000")
const recoveryRetryMs = Number(process.env.OPENCODE_ROUTER_RECOVERY_RETRY_MS || "1500")
const recoveryHtmlTimeoutMs = Number(process.env.OPENCODE_ROUTER_RECOVERY_HTML_TIMEOUT_MS || "15000")

const upstreamAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 16,
  maxFreeSockets: 8,
})

const states = new Map()

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
}

function validIp(value) {
  const parts = value.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!part) return false
    if (!part.split("").every((char) => char >= "0" && char <= "9")) return false
    const num = Number(part)
    return Number.isInteger(num) && num >= 0 && num <= 255
  })
}

function validPort(value) {
  return /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) < 65536
}

function parseCookies(raw) {
  return (raw || "").split(/;\s*/).reduce((out, item) => {
    const i = item.indexOf("=")
    if (i === -1) return out
    out[item.slice(0, i)] = item.slice(i + 1)
    return out
  }, {})
}

function parseTarget(host, port) {
  if (!host) return
  if (!validIp(host)) return
  const nextPort = String(port || "3000")
  if (!validPort(nextPort)) return
  return { host, port: nextPort }
}

function validClient(value) {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(String(value || ""))
}

function createClientID() {
  return `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

function getClientID(reqUrl, options) {
  const opts = options || {}
  const value = reqUrl.searchParams.get("client") || ""
  if (validClient(value)) return value
  if (opts.allowGenerated) return createClientID()
  return sharedClientID
}

function getTarget(reqUrl, headers, options) {
  const opts = options || {}
  const cookies = opts.useCookie === false ? {} : parseCookies(headers.cookie)
  const fromCookie = cookies[targetCookie]?.split(":")
  const host = reqUrl.searchParams.get("host") || fromCookie?.[0] || ""
  const port = reqUrl.searchParams.get("port") || fromCookie?.[1] || "3000"
  if (!host) return opts.allowEmpty ? { host: "", port } : undefined
  return parseTarget(host, port)
}

function setTargetCookie(res, target) {
  res.setHeader("Set-Cookie", `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax`)
}

function clearTargetCookie(res) {
  res.setHeader("Set-Cookie", `${targetCookie}=; Path=/; Max-Age=0; SameSite=Lax`)
}

function json(res, code, body, extra) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(extra || {}),
  })
  res.end(JSON.stringify(body))
}

function raw(res, code, body, type, extra) {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    ...(extra || {}),
  })
  res.end(body)
}

function text(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "public, max-age=86400",
  })
  res.end(body)
}

async function fetchJson(target, path) {
  return fetchJsonWith(target, path, {})
}

function requestText(target, path, headers) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const req = http.request(
      {
        hostname: target.host,
        port: Number(target.port),
        path,
        method: "GET",
        headers: headers || { Accept: "application/json" },
        agent: upstreamAgent,
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
          resolve({
            body,
            latencyMs: Date.now() - start,
            headers: res.headers,
          })
        })
      },
    )
    req.setTimeout(inspectTimeoutMs, () => {
      req.destroy(new Error(`Timed out after ${inspectTimeoutMs}ms`))
    })
    req.on("error", reject)
    req.end()
  })
}

async function fetchJsonWith(target, path, options) {
  const opts = options || {}
  if (opts.state) {
    opts.state.stats.upstreamFetch += 1
    touchState(opts.state)
  }
  const exec = () => requestText(target, path, opts.headers)
  const res = opts.heavy && opts.state ? await runHeavy(opts.state, exec) : await exec()
  const body = res.body
  return {
    data: body ? JSON.parse(body) : null,
    text: body,
    latencyMs: res.latencyMs,
    headers: res.headers,
  }
}

function encodeDir(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function buildSessionLocation(target, launch) {
  if (!launch?.directory || !launch?.sessionID) return null
  const params = new URLSearchParams({ host: target.host, port: target.port })
  if (launch.client && validClient(launch.client)) params.set("client", launch.client)
  return `/${launch.directory}/session/${encodeURIComponent(launch.sessionID)}?${params.toString()}`
}

function isSessionHtmlPath(pathname) {
  return /^\/[^/]+\/session\/[^/]+$/.test(pathname)
}

function isHeavyRequest(reqUrl) {
  if (reqUrl.pathname === "/session/status") return false
  if (reqUrl.pathname === "/session") return true
  return /^\/session\/[^/]+\/message$/.test(reqUrl.pathname)
}

function messageRequestInfo(reqUrl) {
  const match = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (!match) return null
  return {
    sessionID: decodeURIComponent(match[1]),
    limit: Number(reqUrl.searchParams.get("limit") || "0"),
  }
}

function relayPriority(reqUrl, client) {
  if (reqUrl.pathname === "/session") return "foreground"
  const info = messageRequestInfo(reqUrl)
  if (!info) return "foreground"
  if (info.limit <= 80) return "foreground"
  if (!client || client.id === sharedClientID) return "foreground"
  return client.activeSessionID && client.activeSessionID !== info.sessionID ? "background" : "foreground"
}

function rememberActiveSession(client, reqUrl) {
  const match = reqUrl.pathname.match(/^\/[^/]+\/session\/([^/]+)$/)
  if (!match) return
  client.activeSessionID = decodeURIComponent(match[1])
}

function latest(items) {
  return [...items].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))[0]
}

function uniqueDirectories(items) {
  const seen = new Set()
  return items
    .map((item) => item?.directory)
    .filter((dir) => {
      if (!dir || seen.has(dir)) return false
      seen.add(dir)
      return true
    })
    .slice(0, maxProjects)
}

function classifyError(err, fallback) {
  const text = err instanceof Error ? err.message : String(err)
  return text || fallback
}

function isMobile(headers) {
  const ua = String(headers["user-agent"] || "")
  return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua)
}

function keyFor(target) {
  return `${target.host}:${target.port}`
}

function now() {
  return Date.now()
}

function touchState(state) {
  state.lastAccessAt = now()
}

function fresh(at, ttl) {
  return Boolean(at && now() - at < ttl)
}

function cacheKey(directory, sessionID, limit) {
  return `${directory}\n${sessionID}\n${limit}`
}

function createState(target) {
  return {
    target,
    clients: new Map(),
    meta: undefined,
    metaAt: 0,
    sessionList: [],
    lists: new Map(),
    messages: new Map(),
    details: new Map(),
    heavyActive: 0,
    heavyBackgroundActive: 0,
    heavyQueue: [],
    heavyBackgroundQueue: [],
    backgroundActive: 0,
    backgroundQueue: [],
    backgroundKeys: new Set(),
    ptyActive: 0,
    resumeTimer: undefined,
    stats: {
      cacheHit: 0,
      cacheMiss: 0,
      staleLaunch: 0,
      upstreamFetch: 0,
      heavyQueued: 0,
      backgroundQueued: 0,
    },
    lastError: null,
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
    resumeSafeUntil: 0,
    resumeReason: null,
  }
}

function clientSafeMode(client) {
  return Boolean(client.resumeSafeUntil && client.resumeSafeUntil > now())
}

function clientSafeDelay(client) {
  return clientSafeMode(client) ? recoveryRetryMs : 450
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
  const delay = Math.max(0, ...[...state.clients.values()].map((client) => Math.max(0, (client.resumeSafeUntil || 0) - now())))
  if (!delay) {
    state.resumeTimer = undefined
    drainHeavy(state)
    pumpBackground(state)
    return
  }
  state.resumeTimer = setTimeout(() => {
    state.resumeTimer = undefined
    drainHeavy(state)
    pumpBackground(state)
  }, delay)
  state.resumeTimer.unref?.()
}

function enterResumeSafe(state, client, reason) {
  client.resumeSafeUntil = Math.max(client.resumeSafeUntil || 0, now() + idleRecoveryWindowMs)
  client.resumeReason = reason
  scheduleBackgroundResume(state)
}

function touchClient(state, client) {
  const stamp = now()
  if (client.lastAccessAt && stamp - client.lastAccessAt >= idleRecoveryThresholdMs) enterResumeSafe(state, client, "idle-resume")
  client.lastAccessAt = stamp
}

function ensureClientState(state, id) {
  const key = validClient(id) ? id : sharedClientID
  const hit = state.clients.get(key)
  if (hit) {
    touchClient(state, hit)
    return hit
  }
  const next = createClientState(key)
  state.clients.set(key, next)
  return next
}

function ensureState(target) {
  const key = keyFor(target)
  const hit = states.get(key)
  if (hit) {
    touchState(hit)
    return hit
  }
  const next = createState(target)
  states.set(key, next)
  if (states.size > maxTargets) cleanupStates(true)
  return next
}

function setWarm(client, patch) {
  client.warm = { ...client.warm, ...patch }
}

function warmBusy(state) {
  return Boolean(state.promise || state.heavyActive || state.backgroundActive || state.backgroundQueue.length)
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

function cleanupStates(force) {
  const entries = [...states.entries()]
  const threshold = now() - targetIdleMs
  for (const [key, state] of entries) {
    for (const [id, client] of state.clients.entries()) {
      if (client.lastAccessAt < threshold && !client.warm.active) state.clients.delete(id)
    }
    if (!force && state.lastAccessAt >= threshold) continue
    if (state.promise || state.heavyActive || state.backgroundActive || state.ptyActive || state.resumeTimer) continue
    if (state.resumeTimer) clearTimeout(state.resumeTimer)
    states.delete(key)
  }
  if (!force || states.size <= maxTargets) return
  const victims = [...states.entries()]
    .filter(([, state]) => !state.promise && !state.heavyActive && !state.backgroundActive && !state.ptyActive && !state.resumeTimer)
    .sort((a, b) => a[1].lastAccessAt - b[1].lastAccessAt)
  while (states.size > maxTargets && victims.length) {
    states.delete(victims.shift()[0])
  }
}

function canRunHeavy(state, priority) {
  if (state.heavyActive >= maxHeavyRequestsPerTarget) return false
  if (priority === "background" && backgroundWarmPaused(state)) return false
  if (priority === "background" && state.heavyBackgroundActive >= maxBackgroundHeavyRequestsPerTarget) return false
  return true
}

function drainHeavy(state) {
  while (state.heavyQueue.length && canRunHeavy(state, "foreground")) {
    const next = state.heavyQueue.shift()
    next()
  }
  while (!state.heavyQueue.length && state.heavyBackgroundQueue.length && canRunHeavy(state, "background")) {
    const next = state.heavyBackgroundQueue.shift()
    next()
  }
  if (!state.heavyQueue.length && !state.heavyBackgroundQueue.length) pumpBackground(state)
}

function runHeavy(state, work, priority) {
  const mode = priority === "background" ? "background" : "foreground"
  const start = (resolve, reject) => {
    state.heavyActive += 1
    if (mode === "background") state.heavyBackgroundActive += 1
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => {
        state.heavyActive -= 1
        if (mode === "background") state.heavyBackgroundActive -= 1
        drainHeavy(state)
      })
  }
  if (canRunHeavy(state, mode) && (mode === "foreground" || !state.heavyQueue.length)) {
    return new Promise((resolve, reject) => start(resolve, reject))
  }
  state.stats.heavyQueued += 1
  return new Promise((resolve, reject) => {
    const queue = mode === "background" ? state.heavyBackgroundQueue : state.heavyQueue
    queue.push(() => start(resolve, reject))
  })
}

function pumpBackground(state) {
  if (state.heavyActive || state.backgroundActive) return
  if (backgroundWarmPaused(state)) {
    scheduleBackgroundResume(state)
    return
  }
  const next = state.backgroundQueue.shift()
  if (!next) return
  state.backgroundActive += 1
  Promise.resolve()
    .then(next.run)
    .catch((err) => {
      state.lastError = classifyError(err, "Background cache failed")
    })
    .finally(() => {
      state.backgroundActive -= 1
      state.backgroundKeys.delete(next.key)
      if (!state.backgroundQueue.length) syncClients(state)
      pumpBackground(state)
    })
}

function enqueueBackground(state, key, work) {
  if (state.backgroundKeys.has(key)) return false
  state.stats.backgroundQueued += 1
  state.backgroundKeys.add(key)
  state.backgroundQueue.push({ key, run: work })
  pumpBackground(state)
  return true
}

function buildMeta(target, health, list, latencyMs) {
  const root = latest(list)
  return {
    target,
    source: {
      kind: "cli",
      label: "Global CLI service",
    },
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
      directories: uniqueDirectories(list),
      latest: root
        ? {
            id: root.id || null,
            title: root.title || null,
            directory: root.directory || null,
          }
        : null,
      error: list.length ? null : "Target is online but has no historical sessions",
    },
    ready: Boolean(health?.healthy === true && root?.id && root?.directory),
    cache: {
      source: "router",
      cachedAt: now(),
      warm: true,
    },
  }
}

function buildList(list, directory, limit) {
  return list.filter((item) => item?.directory === directory).slice(0, limit)
}

function rememberList(state, directory, limit) {
  const text = JSON.stringify(buildList(state.sessionList, directory, limit))
  state.lists.set(`${directory}\n${limit}`, {
    body: text,
    type: "application/json",
    at: now(),
  })
}

async function cacheMessages(state, target, directory, sessionID, limit) {
  const path = `/session/${encodeURIComponent(sessionID)}/message?limit=${limit}&directory=${encodeURIComponent(directory)}`
  const data = await fetchJsonWith(target, path, { heavy: true, state })
  state.messages.set(cacheKey(directory, sessionID, limit), {
    body: data.text,
    type: "application/json",
    at: now(),
    sessionID,
    directory,
    limit,
  })
}

async function cacheDetail(state, target, directory, sessionID) {
  const path = `/session/${encodeURIComponent(sessionID)}?directory=${encodeURIComponent(directory)}`
  const data = await fetchJsonWith(target, path, { heavy: true, state })
  state.details.set(`${directory}\n${sessionID}`, {
    body: data.text,
    type: "application/json",
    at: now(),
  })
}

function scheduleSnapshotWarm(state, client, target, latestSession, nearby) {
  if (!latestSession?.directory || !latestSession?.id) return
  const detailKey = `${latestSession.directory}\n${latestSession.id}`
  const needsDetail = !fresh(state.details.get(detailKey)?.at, snapshotCacheMs)
  const messageJobs = nearby
    .map((item) => ({ item, limit: item.id === latestSession.id ? 80 : 200 }))
    .filter(({ item, limit }) => !fresh(state.messages.get(cacheKey(item.directory, item.id, limit))?.at, snapshotCacheMs))
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
        await cacheDetail(state, target, latestSession.directory, latestSession.id)
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
        await cacheMessages(state, target, item.directory, item.id, limit)
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

async function warm(state, client, force, options) {
  const opts = options || {}
  const requestedSnapshotCount = opts.snapshotCount || desktopWarmSessionCount
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
  if (!force && fresh(state.metaAt, metaCacheMs) && state.meta) return Promise.resolve(state.meta)
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
      health = await fetchJson(target, "/global/health")
    } catch (err) {
      if (failWarm(state, client, err, "Health check failed")) throw err
      return state.meta
    }

    setWarm(client, {
      percent: 28,
      stage: "index",
      note: "Reading remote session index...",
    })

    let sessions
    try {
      sessions = await fetchJsonWith(target, `/session?limit=${maxSessions}`, { heavy: true, state })
    } catch (err) {
      if (failWarm(state, client, err, "Session scan failed")) throw err
      return state.meta
    }

    state.sessionList = Array.isArray(sessions.data) ? sessions.data : []
    state.meta = buildMeta(target, health.data, state.sessionList, health.latencyMs)
    state.metaAt = now()
    for (const dir of uniqueDirectories(state.sessionList)) rememberList(state, dir, 55)

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
      .slice(0, health.latencyMs >= slowHealthLatencyMs ? 0 : requestedSnapshotCount)

    setWarm(client, {
      active: false,
      ready: true,
      first: false,
      percent: 100,
      stage: "ready",
      note:
        health.latencyMs >= slowHealthLatencyMs
          ? "Upstream is slow. Opening now and reducing background cache work..."
          : client.warm.first
            ? "Cache index is ready. Opening the latest session..."
            : "Latest session is ready. Opening now...",
      cachedAt: now(),
      latestSessionID: latestSession.id,
      latestDirectory: latestSession.directory,
      error: null,
    })

    scheduleSnapshotWarm(state, client, target, latestSession, nearby)

    state.meta.cache = {
      source: "router",
      cachedAt: now(),
      warm: true,
    }

    return state.meta
  }
  const run = Promise.race([
    body(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Warm timed out after ${warmTimeoutMs}ms`)), warmTimeoutMs)),
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

function refresh(state, client) {
  if (state.promise) return
  if (!state.meta) return
  if (fresh(state.metaAt, metaCacheMs)) return
  const launch = client || ensureClientState(state, sharedClientID)
  void warm(state, launch, true, { snapshotCount: snapshotGoal(state, launch.warm.snapshotCount || desktopWarmSessionCount) }).catch(() => {})
}

function progressPayload(state, client) {
  syncWarm(state, client)
  const launchReady = Boolean(state.meta?.ready && state.meta?.sessions?.latest?.id && state.meta?.sessions?.latest?.directory)
  const refreshing = Boolean(client.warm.active && warmBusy(state))
  const payload = {
    target: state.target,
    ready: client.warm.ready && Boolean(state.meta?.ready),
    launchReady,
    refreshing,
    resumeSafeMode: clientSafeMode(client),
    backgroundWarmPaused: backgroundWarmPaused(state),
    retryAfterMs: clientSafeDelay(client),
    cacheState: !state.meta ? "cold" : refreshing ? "stale" : "warm",
    warm: client.warm,
    meta: state.meta || null,
  }
  if (launchReady && state.meta?.sessions?.latest) {
    payload.launch = {
      directory: encodeDir(state.meta.sessions.latest.directory),
      sessionID: state.meta.sessions.latest.id,
      client: client.id,
    }
  }
  return payload
}

function healthPayload() {
  const summary = [...states.values()].map((state) => {
    syncClients(state)
    return {
      target: state.target,
      launchReady: Boolean(state.meta?.ready && state.meta?.sessions?.latest?.id),
      refreshing: warmBusy(state),
      snapshotCount: Math.max(0, ...[...state.clients.values()].map((client) => client.warm.snapshotCount || 0)),
      cachedAt: state.meta?.cache?.cachedAt || 0,
      lastAccessAt: state.lastAccessAt,
      promiseActive: Boolean(state.promise),
      promiseAgeMs: state.promiseStartedAt ? Math.max(0, now() - state.promiseStartedAt) : 0,
      heavyActive: state.heavyActive,
      heavyQueued: state.heavyQueue.length + state.heavyBackgroundQueue.length,
      heavyBackgroundActive: state.heavyBackgroundActive,
      heavyBackgroundQueued: state.heavyBackgroundQueue.length,
      backgroundActive: state.backgroundActive,
      backgroundQueued: state.backgroundQueue.length,
      backgroundKeys: state.backgroundKeys.size,
      backgroundWarmPaused: backgroundWarmPaused(state),
      resumeSafeClients: [...state.clients.values()].filter((client) => clientSafeMode(client)).length,
      ptyActive: state.ptyActive,
      clients: state.clients.size,
      warmStage: state.promise ? "connect" : "ready",
      stats: state.stats,
      lastError: state.lastError,
    }
  })
  return {
    ok: true,
    targets: summary.length,
    states: summary,
  }
}

function sessionTimeoutPage(target, reqUrl, timeoutMs) {
  const sessionPath = escapeHtml(reqUrl.pathname)
  const host = escapeHtml(target.host)
  const port = escapeHtml(target.port)
  const client = reqUrl.searchParams.get("client")
  const launchParams = new URLSearchParams({ host: target.host, port: target.port })
  if (validClient(client)) launchParams.set("client", client)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Session Timeout</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #13233e 0, #08111d 46%); color: #eef4ff; font: 15px/1.5 Inter, "Segoe UI", sans-serif; }
    main { width: min(760px, 100%); border: 1px solid #20314b; border-radius: 22px; padding: 22px; background: rgba(13, 21, 35, .94); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { margin: 10px 0 0; color: #8fa6c7; }
    .actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    a { display: inline-flex; align-items: center; justify-content: center; padding: 11px 15px; border-radius: 12px; border: 1px solid #334155; background: #101b2b; color: #eef4ff; text-decoration: none; }
    .primary { background: linear-gradient(180deg, #3d8cff, #2c7dff); border-color: #3279e7; }
    code { color: #d3e3ff; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>OpenCode session page is taking too long</h1>
    <p>The remote OpenCode HTML route did not return a page within ${timeoutMs} ms. Cached session APIs may still be alive, but the application shell is not loading cleanly right now.</p>
    <p><code>${sessionPath}</code></p>
    <p>Target: <code>${host}:${port}</code></p>
    <div class="actions">
      <a class="primary" href="${escapeHtml(reqUrl.pathname + reqUrl.search)}">Retry this session</a>
      <a href="/__oc/launch?${launchParams.toString()}">Retry via launch</a>
      <a href="/?${launchParams.toString()}">Back to router</a>
    </div>
  </main>
</body>
</html>`
}

async function resolveLaunch(state, client, snapshotCount) {
  const current = progressPayload(state, client)
  if (current.launchReady && current.launch) return current
  try {
    await Promise.race([
      warm(state, client, false, { snapshotCount }),
      new Promise((resolve) => setTimeout(resolve, launchRedirectWaitMs)),
    ])
  } catch {}
  return progressPayload(state, client)
}

function launchPage(target, clientID) {
  const payload = JSON.stringify({ ...target, client: clientID }).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Launching</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #13233e 0, #08111d 46%); color: #eef4ff; font: 15px/1.5 Inter, "Segoe UI", sans-serif; }
    main { width: min(720px, 100%); border: 1px solid #20314b; border-radius: 22px; padding: 22px; background: rgba(13, 21, 35, .94); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { margin: 0; color: #8fa6c7; }
    .bar { margin-top: 18px; width: 100%; height: 10px; border-radius: 999px; background: #162235; overflow: hidden; border: 1px solid #22324b; }
    .fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2c7dff, #66b3ff); transition: width .2s ease; }
    .line { margin-top: 14px; color: #d3e3ff; }
    .hint { margin-top: 10px; color: #8fa6c7; font-size: 13px; }
    ul { margin: 16px 0 0; padding: 0 0 0 18px; color: #c7d8f4; }
    li { margin-top: 6px; }
    code { color: #d3e3ff; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>Launching Remote OpenCode</h1>
    <p>The VPS is warming a cache so future opens do not start cold.</p>
    <div class="bar"><div id="fill" class="fill"></div></div>
    <div id="stage" class="line">Connecting...</div>
    <div id="note" class="hint">Preparing...</div>
    <button id="fallback" type="button" hidden>Open cached session now</button>
    <ul>
      <li>Connect to the remote OpenCode instance</li>
      <li>Read the recent session index</li>
      <li>Cache the latest session snapshot on the VPS</li>
      <li>Open the session and refresh in the background</li>
    </ul>
  </main>
  <script>
    const target = ${payload}
    const fill = document.getElementById('fill')
    const stage = document.getElementById('stage')
    const note = document.getElementById('note')
    const serverKey = 'opencode.global.dat:server'
    const defaultServerKey = 'opencode.settings.dat:defaultServerUrl'
    const snapshotKey = 'opencode.router.dat:snapshot'
    const clientKey = 'opencode.router.dat:client'
    const origin = location.origin
    const fallback = document.getElementById('fallback')
    let polls = 0
    let cachedLaunch = null
    let retryAfter = 450
    function read(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} } }
    function write(key, value) { localStorage.setItem(key, JSON.stringify(value)) }
    sessionStorage.setItem(clientKey, target.client)
    function encodeDir(value) {
      return btoa(unescape(encodeURIComponent(String(value || '')))).split('+').join('-').split('/').join('_').replace(/=+$/g, '')
    }
    async function fetchJson(url, timeoutMs) {
      const ctrl = new AbortController()
      const timer = setTimeout(function () { ctrl.abort() }, timeoutMs || 4000)
      try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal })
        const data = await res.json()
        return { res, data }
      } finally {
        clearTimeout(timer)
      }
    }
    function nextUrl(launch) {
      return '/' + launch.directory + '/session/' + encodeURIComponent(launch.sessionID)
        + '?host=' + encodeURIComponent(target.host)
        + '&port=' + encodeURIComponent(target.port)
        + '&client=' + encodeURIComponent(target.client)
    }
    function reveal(launch) {
      if (!launch) return
      cachedLaunch = launch
      fallback.hidden = false
    }
    function go(launch) {
      reveal(launch)
      location.replace(nextUrl(launch))
    }
    fallback.addEventListener('click', function () {
      if (!cachedLaunch) return
      location.replace(nextUrl(cachedLaunch))
    })
    function serverKeys() {
      const keys = [origin]
      if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') keys.unshift('local')
      return Array.from(new Set(keys))
    }
    function seed(meta) {
      const data = read(serverKey)
      if (!Array.isArray(data.list)) data.list = []
      if (!data.projects || typeof data.projects !== 'object') data.projects = {}
      if (!data.lastProject || typeof data.lastProject !== 'object') data.lastProject = {}
      const seen = new Set()
      const merged = []
      ;(meta.sessions.directories || []).forEach(function (dir, index) {
        if (!dir || seen.has(dir)) return
        seen.add(dir)
        merged.push({ worktree: dir, expanded: index === 0 })
      })
      serverKeys().forEach(function (key) {
        data.projects[key] = merged
        if (meta.sessions.latest && meta.sessions.latest.directory) data.lastProject[key] = meta.sessions.latest.directory
      })
      localStorage.setItem(defaultServerKey, origin)
      write(serverKey, data)
      sessionStorage.setItem(snapshotKey, JSON.stringify({ cachedAt: Date.now(), source: 'vps', target: target }))
    }
    function label(value) {
      const map = {
        connect: 'Connecting to remote OpenCode...',
        index: 'Reading recent session index...',
        snapshot: 'Caching recent session snapshots on the VPS...',
        ready: 'Cache ready. Opening the latest session...',
        error: 'The VPS could not warm this target.',
        idle: 'Preparing...',
      }
      return map[value] || 'Preparing...'
    }
    stage.textContent = 'Connecting to remote OpenCode...'
    note.textContent = 'Reading the VPS launch state...'
    async function tick() {
      const url = '/__oc/progress?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port)
        + '&client=' + encodeURIComponent(target.client)
      const result = await fetchJson(url, 4000)
      const res = result.res
      const data = result.data
      polls += 1
      retryAfter = Math.max(450, Number(data.retryAfterMs || 450))
      fill.style.width = Math.max(4, data.warm && data.warm.percent ? data.warm.percent : 4) + '%'
      stage.textContent = label(data.warm && data.warm.stage)
      note.textContent = data.warm && data.warm.note ? data.warm.note : 'Preparing...'
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      if (data.launchReady && data.launch) {
        reveal(data.launch)
        if (data.meta) seed(data.meta)
        go(data.launch)
        return true
      }
      if (polls % 12 === 0) {
        const metaResult = await fetchJson('/__oc/meta?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port) + '&client=' + encodeURIComponent(target.client), 4000)
        const metaRes = metaResult.res
        const meta = metaResult.data
        if (metaRes.ok && meta && meta.ready && meta.sessions && meta.sessions.latest) {
          seed(meta)
          go({ directory: encodeDir(meta.sessions.latest.directory), sessionID: meta.sessions.latest.id })
          return true
        }
      }
      return false
    }
    async function loop() {
      for (;;) {
        try {
          const done = await tick()
          if (done) return
        } catch (error) {
          stage.textContent = 'The VPS could not warm this target.'
          note.textContent = error && error.message ? error.message : String(error)
          if (cachedLaunch) {
            fallback.hidden = false
            note.textContent += ' You can open the cached session now.'
            await new Promise((resolve) => setTimeout(resolve, 1500))
            location.replace(nextUrl(cachedLaunch))
            return
          }
        }
        await new Promise((resolve) => setTimeout(resolve, retryAfter))
      }
    }
    loop()
  </script>
</body>
</html>`
}

function rewriteLocation(value, reqUrl, target) {
  if (!value || !value.startsWith("/")) return value
  const next = new URL(value, `http://${reqUrl.headersHost || "localhost"}`)
  next.searchParams.set("host", target.host)
  next.searchParams.set("port", target.port)
  const client = reqUrl.searchParams?.get?.("client")
  if (validClient(client)) next.searchParams.set("client", client)
  return `${next.pathname}${next.search}${next.hash}`
}

function landing(target) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Tailnet Router</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #13233e 0, #08111d 46%); color: #eef4ff; font: 15px/1.5 Inter, "Segoe UI", sans-serif; }
    main { width: min(760px, 100%); background: rgba(13, 21, 35, .94); border: 1px solid #20314b; border-radius: 22px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0; font-size: 30px; line-height: 1.12; }
    p { margin: 10px 0 0; color: #8fa6c7; }
    .grid { display: grid; grid-template-columns: 1fr 110px; gap: 12px; margin-top: 18px; }
    label { display: block; margin: 0 0 6px; color: #8fa6c7; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    input { width: 100%; height: 48px; border-radius: 12px; border: 1px solid #334155; background: #020617; color: #eef4ff; padding: 0 14px; font-size: 15px; }
    .actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    button { display: inline-flex; align-items: center; justify-content: center; padding: 11px 15px; border-radius: 12px; border: 1px solid #334155; background: #101b2b; color: #eef4ff; cursor: pointer; font: inherit; }
    .primary { background: linear-gradient(180deg, #3d8cff, #2c7dff); border-color: #3279e7; }
    .status { margin-top: 14px; color: #8fa6c7; min-height: 20px; }
    .meta { margin-top: 14px; padding: 14px; border: 1px solid #20314b; border-radius: 14px; background: rgba(7, 12, 22, .92); display: grid; gap: 10px; }
    .line { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .k { color: #8fa6c7; min-width: 108px; }
    .ok { color: #79e29b; }
    .bad { color: #f1bc65; }
    code { color: #d3e3ff; word-break: break-all; }
    ul { margin: 6px 0 0 18px; padding: 0; color: #d3e3ff; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } .k { min-width: auto; } }
  </style>
</head>
<body>
  <main>
    <h1>OpenCode Tailnet Router</h1>
    <p>Enter the Tailscale IPv4 and port for a machine already running the CLI version of OpenCode web.</p>
    <div class="grid">
      <div><label for="host">Tailscale IPv4</label><input id="host" value="${escapeHtml(target.host)}" placeholder="100.x.x.x"></div>
      <div><label for="port">Port</label><input id="port" value="${escapeHtml(target.port)}" placeholder="3000"></div>
    </div>
    <div class="actions">
      <button id="open" class="primary" type="button">Open Remote OpenCode</button>
      <button id="check" type="button">Check</button>
      <button id="clear" type="button">Clear</button>
    </div>
    <div id="status" class="status"></div>
    <div id="meta" class="meta">Enter a target and click Check.</div>
  </main>
  <script>
    const host = document.getElementById('host')
    const port = document.getElementById('port')
    const status = document.getElementById('status')
    const meta = document.getElementById('meta')
    const clientKey = 'opencode.router.dat:client'
    function validIp(value) {
      const parts = value.split('.')
      if (parts.length !== 4) return false
      return parts.every(function (part) {
        if (!part) return false
        if (!part.split('').every(function (char) { return char >= '0' && char <= '9' })) return false
        const num = Number(part)
        return Number.isInteger(num) && num >= 0 && num <= 255
      })
    }
    function cleanPort(value) {
      const chars = value.split('').filter(function (char) { return char >= '0' && char <= '9' }).join('')
      return chars || '3000'
    }
    function validClient(value) {
      return /^[a-zA-Z0-9_-]{8,64}$/.test(String(value || ''))
    }
    function client() {
      const hit = sessionStorage.getItem(clientKey)
      if (validClient(hit)) return hit
      const next = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
      sessionStorage.setItem(clientKey, next)
      return next
    }
    function target() {
      const ip = host.value.trim()
      const p = cleanPort(port.value.trim() || '3000')
      if (!validIp(ip)) throw new Error('Invalid Tailscale IPv4')
      return { host: ip, port: p }
    }
    function renderMeta(data) {
      const healthOk = data.health && data.health.ok
      const sessionsOk = data.sessions && data.sessions.ok
      const healthText = healthOk ? '<span class="ok">healthy</span>' : '<span class="bad">' + (data.health && data.health.error ? data.health.error : 'unreachable') + '</span>'
      const versionText = data.health && data.health.version ? data.health.version : 'unknown'
      const latencyText = data.health && typeof data.health.latencyMs === 'number' ? data.health.latencyMs + ' ms' : 'n/a'
      const latestTitle = sessionsOk && data.sessions.latest ? (data.sessions.latest.title || data.sessions.latest.id || 'none') : 'none'
      const latestDir = sessionsOk && data.sessions.latest ? data.sessions.latest.directory : 'none'
      const cacheText = data.cache && data.cache.cachedAt ? new Date(data.cache.cachedAt).toLocaleTimeString() : 'n/a'
      const directories = sessionsOk && Array.isArray(data.sessions.directories) && data.sessions.directories.length
        ? '<ul>' + data.sessions.directories.map(function (item) { return '<li><code>' + item + '</code></li>' }).join('') + '</ul>'
        : '<div class="bad">' + (data.sessions && data.sessions.error ? data.sessions.error : 'No restoreable directories found') + '</div>'
      meta.innerHTML = ''
        + '<div class="line"><span class="k">Target</span><code>' + data.target.host + ':' + data.target.port + '</code></div>'
        + '<div class="line"><span class="k">Source</span><code>' + ((data.source && data.source.label) || 'Global CLI service') + '</code></div>'
        + '<div class="line"><span class="k">CLI Version</span><code>' + versionText + '</code></div>'
        + '<div class="line"><span class="k">Health</span>' + healthText + '<span class="k">Latency</span><code>' + latencyText + '</code></div>'
        + '<div class="line"><span class="k">Latest Session</span><code>' + latestTitle + '</code></div>'
        + '<div class="line"><span class="k">Latest Directory</span><code>' + latestDir + '</code></div>'
        + '<div class="line"><span class="k">Cache Built</span><code>' + cacheText + '</code></div>'
        + '<div class="line"><span class="k">Directories</span></div>'
        + directories
    }
    async function inspect() {
      const t = target()
      status.textContent = 'Reading the VPS cache and refreshing metadata...'
      const url = '/__oc/meta?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      renderMeta(data)
      if (data.ready) { status.textContent = 'Target is ready'; return data }
      if (!data.health || !data.health.ok) throw new Error(data.health && data.health.error ? data.health.error : 'Target unreachable')
      if (!data.sessions || !data.sessions.ok) throw new Error(data.sessions && data.sessions.error ? data.sessions.error : 'Session scan failed')
      throw new Error('Target is online but has no restoreable session')
    }
    async function openLatest() {
      try {
        const t = target()
        status.textContent = 'Warming the VPS cache and preparing the latest session...'
        location.href = '/__oc/launch?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      } catch (error) {
        status.textContent = error.message || String(error)
      }
    }
    document.getElementById('open').addEventListener('click', openLatest)
    document.getElementById('check').addEventListener('click', function () { inspect().catch(function (error) { status.textContent = error.message || String(error) }) })
    document.getElementById('clear').addEventListener('click', function () {
      host.value = ''
      port.value = '3000'
      status.textContent = ''
      meta.textContent = 'Enter a target and click Check.'
      sessionStorage.removeItem(clientKey)
      fetch('/__oc/clear', { method: 'POST', credentials: 'same-origin' }).catch(function () {})
      host.focus()
    })
    for (const input of [host, port]) input.addEventListener('keydown', function (event) { if (event.key === 'Enter') openLatest() })
  </script>
</body>
</html>`
}

function cleanSearch(input) {
  const next = new URLSearchParams(input)
  next.delete("host")
  next.delete("port")
  next.delete("client")
  const text = next.toString()
  return text ? `?${text}` : ""
}

function maybeServeCached(req, res, state, client, reqUrl) {
  if (req.method !== "GET") return false
  syncWarm(state, client)
  touchState(state)
  touchClient(state, client)
  const directory = reqUrl.searchParams.get("directory") || client.warm.latestDirectory
  const priority = relayPriority(reqUrl, client)

  if (reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true" && directory) {
    const limit = Number(reqUrl.searchParams.get("limit") || "55")
    const hit = state.lists.get(`${directory}\n${limit}`) || state.lists.get(`${directory}\n55`)
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    state.stats.cacheHit += 1
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state, client)
    raw(res, hit.status || 200, hit.body, hit.type, { "X-OC-Cache": "hit", "X-OC-Relay-Priority": priority })
    return true
  }

  const match = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (match && directory && !reqUrl.searchParams.has("cursor")) {
    const sessionID = decodeURIComponent(match[1])
    const limit = Number(reqUrl.searchParams.get("limit") || "0")
    const hit = state.messages.get(cacheKey(directory, sessionID, limit))
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    state.stats.cacheHit += 1
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state, client)
    raw(res, hit.status || 200, hit.body, hit.type, { "X-OC-Cache": "hit", "X-OC-Relay-Priority": priority })
    return true
  }

  const detail = reqUrl.pathname.match(/^\/session\/([^/]+)$/)
  if (detail && directory) {
    const sessionID = decodeURIComponent(detail[1])
    const hit = state.details.get(`${directory}\n${sessionID}`)
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    state.stats.cacheHit += 1
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state, client)
    raw(res, hit.status || 200, hit.body, hit.type, { "X-OC-Cache": "hit", "X-OC-Relay-Priority": priority })
    return true
  }

  return false
}

function proxyRequest(req, res, target, reqUrl, state, client) {
  const heavy = req.method === "GET" && isHeavyRequest(reqUrl)
  const priority = relayPriority(reqUrl, client)
  const guardHtml = req.method === "GET" && isSessionHtmlPath(reqUrl.pathname)
  const htmlTimeoutMs = clientSafeMode(client) ? recoveryHtmlTimeoutMs : htmlProxyTimeoutMs
  const runRequest = () => {
    const options = {
      hostname: target.host,
      port: Number(target.port),
      method: req.method,
      path: `${reqUrl.pathname}${cleanSearch(reqUrl.searchParams)}`,
      headers: {
        ...req.headers,
        host: `${target.host}:${target.port}`,
        connection: req.headers.upgrade ? "upgrade" : "keep-alive",
        "accept-encoding": "identity",
      },
      agent: upstreamAgent,
    }
    let finished = false
    delete options.headers.cookie
    delete options.headers["content-length"]
    const upstream = http.request(options, (up) => {
      if (finished) return
      finished = true
      const headers = { ...up.headers }
      headers["x-oc-relay-priority"] = priority
      delete headers["content-security-policy"]
      delete headers["content-security-policy-report-only"]
      const location = rewriteLocation(headers.location, { headersHost: req.headers.host }, target)
      if (location) headers.location = location
      else delete headers.location
      const wantCookie = reqUrl.searchParams.has("host") || reqUrl.searchParams.has("port")
      if (wantCookie) headers["set-cookie"] = [`${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax`]

      const dir = reqUrl.searchParams.get("directory") || client?.warm?.latestDirectory
      const msg = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
      const limit = Number(reqUrl.searchParams.get("limit") || "0")
      const canStore = req.method === "GET" && dir && !reqUrl.searchParams.has("cursor") && ((msg && (limit === 80 || limit === 200)) || reqUrl.pathname === "/session" || /^\/session\/[^/]+$/.test(reqUrl.pathname))

      if (!canStore) {
        if (guardHtml && (up.statusCode || 0) >= 200 && (up.statusCode || 0) < 300) rememberActiveSession(client, reqUrl)
        res.writeHead(up.statusCode || 502, headers)
        up.pipe(res)
        return
      }

      const chunks = []
      up.on("data", (chunk) => chunks.push(chunk))
      up.on("end", () => {
        const status = up.statusCode || 502
        const body = Buffer.concat(chunks).toString("utf8")
        const ok = status >= 200 && status < 300
        if (ok && msg) {
          const sessionID = decodeURIComponent(msg[1])
          state.messages.set(cacheKey(dir, sessionID, limit), {
            body,
            type: String(headers["content-type"] || "application/json"),
            status,
            at: now(),
            sessionID,
            directory: dir,
            limit,
          })
        }
        if (ok && reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true") {
          state.lists.set(`${dir}\n${Number(reqUrl.searchParams.get("limit") || "55")}`, {
            body,
            type: String(headers["content-type"] || "application/json"),
            status,
            at: now(),
          })
        }
        const detail = reqUrl.pathname.match(/^\/session\/([^/]+)$/)
        if (ok && detail && dir) {
          state.details.set(`${dir}\n${decodeURIComponent(detail[1])}`, {
            body,
            type: String(headers["content-type"] || "application/json"),
            status,
            at: now(),
          })
        }
        if (guardHtml && ok) rememberActiveSession(client, reqUrl)
        res.writeHead(status, headers)
        res.end(body)
      })
    })
    if (guardHtml) {
      upstream.setTimeout(htmlTimeoutMs, () => {
        if (finished) return
        finished = true
        upstream.destroy(new Error(`Session HTML timed out after ${htmlTimeoutMs}ms`))
        raw(res, 504, sessionTimeoutPage(target, reqUrl, htmlTimeoutMs), "text/html")
      })
    }
    upstream.on("error", (err) => {
      if (finished) return
      finished = true
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (guardHtml && /timed out/i.test(classifyError(err, ""))) {
        raw(res, 504, sessionTimeoutPage(target, reqUrl, htmlTimeoutMs), "text/html")
        return
      }
      json(res, 502, { error: err.message })
    })
    req.on("data", (chunk) => upstream.write(chunk))
    req.on("end", () => upstream.end())
  }
  if (heavy) {
    runHeavy(state, runRequest, priority).catch((err) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      json(res, 502, { error: classifyError(err, "Upstream request failed") })
    })
    return
  }
  runRequest()
}

function writeUpgradeResponse(socket, response) {
  const lines = [`HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || "Switching Protocols"}`]
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`))
    else if (value !== undefined) lines.push(`${key}: ${value}`)
  }
  lines.push("", "")
  socket.write(lines.join("\r\n"))
}

function proxyUpgrade(req, socket, head, target, reqUrl, state) {
  const terminal = /^\/pty\/[^/]+\/connect$/.test(reqUrl.pathname)
  if (terminal) state.ptyActive += 1
  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    if (!terminal) return
    state.ptyActive = Math.max(0, state.ptyActive - 1)
    drainHeavy(state)
    pumpBackground(state)
  }
  const upstream = http.request({
    hostname: target.host,
    port: Number(target.port),
    method: req.method,
    path: `${reqUrl.pathname}${cleanSearch(reqUrl.searchParams)}`,
    headers: { ...req.headers, host: `${target.host}:${target.port}`, connection: "upgrade" },
    agent: upstreamAgent,
  })
  if (terminal) {
    socket.on("close", () => {
      cleanup()
      if (!upstream.destroyed) upstream.destroy()
    })
    socket.on("error", () => {
      cleanup()
      if (!upstream.destroyed) upstream.destroy()
    })
  }
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    writeUpgradeResponse(socket, upRes)
    if (head && head.length) upSocket.write(head)
    if (upHead && upHead.length) socket.write(upHead)
    upSocket.on("close", cleanup)
    socket.on("close", cleanup)
    upSocket.on("error", cleanup)
    socket.on("error", cleanup)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
  })
  upstream.on("response", () => {
    cleanup()
    socket.destroy()
  })
  upstream.on("error", () => {
    cleanup()
    socket.destroy()
  })
  upstream.end()
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  if (reqUrl.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" })
    res.end()
    return
  }
  if (reqUrl.pathname === "/site.webmanifest") {
    text(
      res,
      200,
      JSON.stringify({
        name: "OpenCode",
        short_name: "OpenCode",
        display: "standalone",
        start_url: "/",
        background_color: "#08111d",
        theme_color: "#08111d",
        icons: [],
      }),
      "application/manifest+json",
    )
    return
  }
  const isLanding = !reqUrl.pathname || reqUrl.pathname === "/" || reqUrl.pathname === "/index.html" || reqUrl.pathname === "/__landing"
  if (isLanding) {
    const target = getTarget(reqUrl, req.headers, { allowEmpty: true, useCookie: false }) || { host: "", port: "3000" }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(landing(target))
    return
  }
  if (reqUrl.pathname === "/__oc/clear") {
    clearTargetCookie(res)
    json(res, 200, { ok: true })
    return
  }
  if (reqUrl.pathname === "/__oc/healthz") {
    json(res, 200, healthPayload())
    return
  }
  const target = getTarget(reqUrl, req.headers)
  if (!target) {
    json(res, 400, { error: "Invalid target host or port" })
    return
  }
  const state = ensureState(target)
  const client = ensureClientState(state, getClientID(reqUrl, { allowGenerated: reqUrl.pathname === "/__oc/launch" }))
  const snapshotCount = isMobile(req.headers) ? mobileWarmSessionCount : desktopWarmSessionCount
  const wantCookie = reqUrl.searchParams.has("host") || reqUrl.searchParams.has("port")

  if (reqUrl.pathname === "/__oc/progress") {
    try {
      json(res, 200, progressPayload(state, client), wantCookie ? { "Set-Cookie": `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax` } : undefined)
    } catch (err) {
      json(res, 502, { error: classifyError(err, "Warm failed") })
    }
    return
  }

  if (reqUrl.pathname === "/__oc/meta") {
    try {
      const meta = state.meta && state.meta.ready ? state.meta : await warm(state, client, false, { snapshotCount })
      refresh(state, client)
      json(res, 200, meta, wantCookie ? { "Set-Cookie": `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax` } : undefined)
    } catch (err) {
      json(res, 502, { error: classifyError(err, "Target inspection failed") })
    }
    return
  }

  if (reqUrl.pathname === "/__oc/launch") {
    const payload = await resolveLaunch(state, client, snapshotCount)
    if (wantCookie) setTargetCookie(res, target)
    if (payload.launchReady && payload.launch) {
      res.writeHead(302, { Location: buildSessionLocation(target, payload.launch), "Cache-Control": "no-store" })
      res.end()
      return
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(launchPage(target, client.id))
    return
  }

  if (wantCookie) setTargetCookie(res, target)
  if (maybeServeCached(req, res, state, client, reqUrl)) return
  proxyRequest(req, res, target, reqUrl, state, client)
})

server.on("upgrade", (req, socket, head) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const target = getTarget(reqUrl, req.headers)
  if (!target) {
    socket.destroy()
    return
  }
  const state = ensureState(target)
  proxyUpgrade(req, socket, head, target, reqUrl, state)
})

setInterval(() => cleanupStates(false), cleanupIntervalMs).unref()

server.listen(bindPort, bindHost, () => {
  console.log(`OpenCode router listening on http://${bindHost}:${bindPort}`)
})
