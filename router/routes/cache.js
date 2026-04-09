"use strict"

const { raw, relayHeaders } = require("../http")
const { touchState, touchClient, clearLastReason, requestDirectory, messageBypass, relayPriority } = require("../state")
const { syncWarm, refresh } = require("../warm")
const { fresh, cacheKey } = require("../util")

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

  if (reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true" && directory) {
    const limit = Number(reqUrl.searchParams.get("limit") || "55")
    const hit = state.lists.get(`${directory}\n${limit}`) || state.lists.get(`${directory}\n55`)
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

  const match = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (match && directory && !reqUrl.searchParams.has("cursor")) {
    const sessionID = decodeURIComponent(match[1])
    const limit = Number(reqUrl.searchParams.get("limit") || "0")
    if (messageBypass(state, client, directory, sessionID, limit)) {
      state.stats.cacheBypass += 1
      clearLastReason(state, client)
      return false
    }
    const hit = state.messages.get(cacheKey(directory, sessionID, limit))
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
    state.stats.cacheHit += 1
    clearLastReason(state, client)
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state, client, config)
    raw(res, hit.status || 200, hit.body, hit.type, cacheHeaders(priority))
    return true
  }

  return false
}

module.exports = { maybeServeCached }
