"use strict"

const { raw, relayHeaders } = require("../http")
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

function maybeServeCached(ctx, req, res) {
  if (req.method !== "GET") return false
  const { state, client, reqUrl, config } = ctx
  if (!state || !client) return false
  const snapshotCacheMs = config.snapshotCacheMs || 45000
  const cacheHeaders = (priority) => ({
    ...relayHeaders(priority, "cache", "cache-hit", "hit"),
    ...(state.offline ? { "X-OC-Offline": "true" } : {}),
  })

  syncWarm(state, client)
  touchState(state)
  touchClient(state, client, config)
  const directory = requestDirectory(client, reqUrl)
  const priority = relayPriority(reqUrl, client)
  const assetCacheMs = config.assetCacheMs || 24 * 60 * 60 * 1000
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
    res.writeHead(hit.status || 200, {
      ...(hit.headers || {}),
      ...relayHeaders(priority, 'cache', 'cache-hit', 'hit'),
      ...(state.offline ? { 'X-OC-Offline': 'true' } : {}),
    })
    res.end(hit.body)
    return true
  }

  if (/^\/(global\/config|provider|config|session\/status|project|path)$/.test(reqUrl.pathname)) {
    const hit = state.bootstrap?.get(bootstrapKey(reqUrl.pathname, directory)) || state.bootstrap?.get(bootstrapKey(reqUrl.pathname, ""))
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
    const body = reqUrl.pathname === "/project" ? rewriteProjectBody(state, hit.body) : hit.body
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
      return false
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
    const hit = state.messages.get(cacheKey(directory, sessionID, limit))
    if (messageBypass(state, client, directory, sessionID, limit)) {
      state.stats.cacheBypass += 1
      clearLastReason(state, client)
      return false
    }
    if (!hit) {
      state.stats.cacheMiss += 1
      return false
    }
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state, client, config)
    raw(res, hit.status || 200, hit.body, hit.type, cacheHeaders(priority))
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
      return false
    }
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    raw(res, hit.status || 200, hit.body, hit.type, cacheHeaders(priority))
    return true
  }

  return false
}

module.exports = { maybeServeCached }
