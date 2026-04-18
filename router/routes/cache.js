"use strict"

const { raw, relayHeaders, runtimeHeaders } = require("../http")
const { touchState, touchClient, clearLastReason, requestDirectory, messageBypass, relayPriority } = require("../state")
const { syncWarm, refresh, workspaceListForLimit, buildWorkspaceRoots, projectInventory } = require("../warm")
const { fresh, cacheKey, bootstrapKey } = require("../util")

function currentProject(state, directory) {
  const list = Array.isArray(state.meta?.projects?.inventory) ? state.meta.projects.inventory : state.inventory
  const hit = (Array.isArray(list) ? list : []).find((item) => String(item?.worktree || "").toLowerCase() === String(directory || "").toLowerCase())
  if (hit) return hit
  const extra = Array.isArray(state.config?.extraRoots) ? state.config.extraRoots : []
  if (!extra.some((item) => String(item || "").toLowerCase() === String(directory || "").toLowerCase())) return null
  // Synthetic project: display-only. Must not feed back into state.meta or session latest.
  return {
    id: `relay:${Buffer.from(String(directory), "utf8").toString("base64").replace(/=+$/g, "")}`,
    worktree: directory,
    sandboxes: [],
    time: {
      created: Date.now(),
      updated: Date.now(),
    },
  }
}

function parseJsonArray(body) {
  try {
    const rows = JSON.parse(String(body || "[]"))
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function rewriteProjectBody(state, body) {
  const meta = Array.isArray(state.meta?.projects?.inventory) ? state.meta.projects.inventory : null
  const seen = new Set()
  const roots = []
  for (const dir of [...buildWorkspaceRoots(state.inventory, state.sessionList, state.config?.extraRoots), ...((state.meta?.projects?.roots || []).filter(Boolean))]) {
    const key = String(dir || "").toLowerCase()
    if (!dir || seen.has(key)) continue
    seen.add(key)
    roots.push(dir)
  }
  const source = meta && meta.length ? meta : parseJsonArray(body)
  return JSON.stringify(projectInventory(source, roots))
}

function rewritePathBody(directory, body) {
  try {
    const parsed = JSON.parse(String(body || "{}"))
    return JSON.stringify({ ...parsed, directory, worktree: directory })
  } catch {
    return JSON.stringify({ directory, worktree: directory })
  }
}

function maybeServeCached(ctx, req, res) {
  if (req.method !== "GET") return false
  const { state, client, reqUrl, config } = ctx
  if (!state || !client) return false
  const snapshotCacheMs = config.snapshotCacheMs || 45000
  const authoritySnapshot = (sessionID, directory) => ({
    requestedSessionID: sessionID || "",
    requestedDirectory: directory || "",
    activeSessionID: client?.activeSessionID || "",
    activeDirectory: client?.activeDirectory || "",
    viewSessionID: client?.view?.sessionID || "",
    viewDirectory: client?.view?.directory || "",
    latestSessionID: state.meta?.sessions?.latest?.id || "",
    latestDirectory: state.meta?.sessions?.latest?.directory || "",
  })
  const cacheHeaders = (priority, reason = "cache-hit", cache = "hit") => ({
    ...relayHeaders(priority, "cache", reason, cache),
    ...(state.offline ? { "X-OC-Offline": "true" } : {}),
  })
  const serveStale = (hit, body, type) => {
    state.stats.staleCacheServe += 1
    clearLastReason(state, client)
    raw(res, hit.status || 200, body ?? hit.body, type || hit.type, cacheHeaders(priority, "cache-stale", "stale"))
    return true
  }

  syncWarm(state, client)
  touchState(state)
  touchClient(state, client, config)
  const directory = requestDirectory(client, reqUrl, ctx.refererView?.directory)
  const priority = relayPriority(reqUrl, client)
  const assetCacheMs = config.assetCacheMs || 24 * 60 * 60 * 1000
  const directoryScopedBootstrap = new Set(["/path", "/agent"])
  if (/^\/(assets\/|favicon|site\.webmanifest)/.test(reqUrl.pathname)) {
    const hit = state.assets?.get(reqUrl.pathname)
    if (!hit || !hit.headers || !hit.headers['content-type']) {
      state.stats.cacheMiss += 1
      return false
    }
    if (!fresh(hit.at, assetCacheMs)) {
      state.stats.cacheMiss += 1
      return false
    }
    state.stats.cacheHit += 1
    res.writeHead(hit.status || 200, runtimeHeaders({
      ...(hit.headers || {}),
      ...relayHeaders(priority, 'cache', 'cache-hit', 'hit'),
      ...(state.offline ? { 'X-OC-Offline': 'true' } : {}),
    }))
    res.end(hit.body)
    return true
  }

  if (/^\/(global\/config|provider|config|session\/status|project|path|agent)$/.test(reqUrl.pathname)) {
    const hit = state.bootstrap?.get(bootstrapKey(reqUrl.pathname, directory)) || (!directoryScopedBootstrap.has(reqUrl.pathname) ? state.bootstrap?.get(bootstrapKey(reqUrl.pathname, "")) : null)
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    if (!fresh(hit.at, snapshotCacheMs)) {
      state.stats.cacheMiss += 1
      refresh(state, client, config)
      const body = reqUrl.pathname === "/project"
        ? rewriteProjectBody(state, hit.body)
        : reqUrl.pathname === "/path" && directory
          ? rewritePathBody(directory, hit.body)
          : hit.body
      return serveStale(hit, body, hit.type)
    }
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    const body = reqUrl.pathname === "/project"
      ? rewriteProjectBody(state, hit.body)
      : reqUrl.pathname === "/path" && directory
        ? rewritePathBody(directory, hit.body)
        : hit.body
    raw(res, hit.status || 200, body, hit.type, cacheHeaders(priority))
    return true
  }

  if (reqUrl.pathname === "/project/current" && directory) {
    const item = currentProject(state, directory)
    if (item?.id && String(item.id).startsWith("relay:")) {
      state.stats.cacheHit += 1
      clearLastReason(state, client)
      raw(res, 200, JSON.stringify(item), "application/json", cacheHeaders(priority))
      return true
    }
    const hit = state.projects?.get(directory)
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    if (!fresh(hit.at, snapshotCacheMs)) {
      state.stats.cacheMiss += 1
      refresh(state, client, config)
      return false
    }
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    raw(res, hit.status || 200, hit.body, hit.type, cacheHeaders(priority))
    return true
  }

  if (reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true" && directory) {
    const limit = Number(reqUrl.searchParams.get("limit") || "55")
    const hit = workspaceListForLimit(state, directory, limit)
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    if (!fresh(hit.at, snapshotCacheMs)) {
      state.stats.cacheMiss += 1
      refresh(state, client, config)
      return serveStale(hit)
    }
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    raw(res, hit.status || 200, hit.body, hit.type, cacheHeaders(priority))
    return true
  }

  const match = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (match && directory && !reqUrl.searchParams.has("cursor") && !reqUrl.searchParams.has("before")) {
    const sessionID = decodeURIComponent(match[1])
    const limit = Number(reqUrl.searchParams.get("limit") || "0")
    if (limit === 80) {
      state.stats.cacheBypass += 1
      clearLastReason(state, client)
      return false
    }
    const hit = state.messages.get(cacheKey(directory, sessionID, limit))
    const bypass = messageBypass(state, client, directory, sessionID, limit)
    if (bypass) {
      state.stats.cacheBypass += 1
      clearLastReason(state, client)
      return false
    }
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    if (!fresh(hit.at, snapshotCacheMs)) {
      state.stats.cacheMiss += 1
      refresh(state, client, config)
      return serveStale(hit)
    }
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    const ageMs = hit?.at ? Math.max(0, Date.now() - hit.at) : -1
    const authority = authoritySnapshot(sessionID, directory)
    raw(res, hit.status || 200, hit.body, hit.type, {
      ...cacheHeaders(priority),
      "X-OC-Message-Cache": "hit",
      "X-OC-Message-Cache-Age": String(ageMs),
      "X-OC-Message-Cache-Source": String(hit?.source || "memory"),
      "X-OC-Message-Cache-Source-At": String(hit?.sourceAt || hit?.restoredAt || hit?.at || 0),
      "X-OC-Message-Requested-Session": authority.requestedSessionID,
      "X-OC-Message-Active-Session": authority.activeSessionID,
      "X-OC-Message-View-Session": authority.viewSessionID,
      "X-OC-Message-Latest-Session": authority.latestSessionID,
    })
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
    if (!fresh(hit.at, snapshotCacheMs)) {
      state.stats.cacheMiss += 1
      refresh(state, client, config)
      return serveStale(hit)
    }
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    raw(res, hit.status || 200, hit.body, hit.type, cacheHeaders(priority))
    return true
  }

  return false
}

module.exports = { maybeServeCached }
