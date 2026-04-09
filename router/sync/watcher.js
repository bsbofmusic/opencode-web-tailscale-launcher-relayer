"use strict"

const { backgroundWarmPaused, setLastReason } = require("../state")
const { uniqueDirectories } = require("../util")
const { emitTargetEvent } = require("./bus")
const { saveStateCache } = require("./disk-cache")

async function tickWatcher(state, config) {
  if (state.watcherBusy || !state.meta?.ready || !state.clients.size) return
  if (state.promise || backgroundWarmPaused(state)) return
  state.watcherBusy = true
  const { fetchJson, fetchJsonWith, buildMeta, rememberList } = require("../warm")
  try {
    const wasOffline = state.offline
    const health = await fetchJson(state.target, "/global/health", config)
    const sessions = await fetchJsonWith(state.target, `/session?limit=${config.maxSessions || 80}`, { state, priority: "background", heavy: true }, config)

    state.offline = false
    state.offlineReason = null

    const prevList = JSON.stringify(state.sessionList)
    state.sessionList = Array.isArray(sessions.data) ? sessions.data : []
    state.meta = buildMeta(state.target, health.data, state.sessionList, health.latencyMs, config)
    state.metaAt = Date.now()
    for (const dir of uniqueDirectories(state.sessionList, config.maxProjects || 12)) rememberList(state, dir, 55)

    if (prevList !== JSON.stringify(state.sessionList)) {
      emitTargetEvent(state.target, "session-list-updated", {
        count: state.sessionList.length,
        latestID: state.meta?.sessions?.latest?.id || null,
      })
    }

    const entries = [...state.messages.entries()]
    for (const [entryKey, entry] of entries) {
      const next = await fetchJsonWith(
        state.target,
        `/session/${encodeURIComponent(entry.sessionID)}/message?limit=${entry.limit}&directory=${encodeURIComponent(entry.directory)}`,
        { state, priority: "background", heavy: true },
        config,
      )
      if (next.text === entry.body) continue
      const prevCount = Array.isArray(JSON.parse(entry.body || "[]")) ? JSON.parse(entry.body || "[]").length : 0
      const nextCount = Array.isArray(next.data) ? next.data.length : 0
      state.messages.set(entryKey, {
        ...entry,
        body: next.text,
        type: "application/json",
        at: Date.now(),
      })
      emitTargetEvent(state.target, "message-appended", {
        sessionID: entry.sessionID,
        directory: entry.directory,
        limit: entry.limit,
        previousCount: prevCount,
        nextCount,
      })
    }

    saveStateCache(state, config)

    if (wasOffline) {
      emitTargetEvent(state.target, "target-health-changed", { healthy: true })
    }
  } catch (err) {
    const becameOffline = !state.offline
    state.offline = true
    state.offlineReason = err.message
    setLastReason(state, null, "watcher-offline")
    if (becameOffline) {
      emitTargetEvent(state.target, "target-health-changed", { healthy: false, error: err.message })
    }
  } finally {
    state.watcherBusy = false
  }
}

function startWatcher(state, config) {
  const interval = Number(config?.watchIntervalMs || 0)
  if (!interval || state.watcherTimer) return
  state.watcherTimer = setInterval(() => {
    void tickWatcher(state, config)
  }, interval)
  state.watcherTimer.unref?.()
}

function stopWatcher(state) {
  if (!state.watcherTimer) return
  clearInterval(state.watcherTimer)
  state.watcherTimer = undefined
}

module.exports = {
  tickWatcher,
  startWatcher,
  stopWatcher,
}
