"use strict"

const fs = require("fs")
const path = require("path")
const { keyFor, now } = require("../util")

function cacheFile(config, target) {
  const root = config?.cacheDir
  if (!root) return null
  const safe = keyFor(target).replace(/[^a-zA-Z0-9._-]+/g, "_")
  return path.join(root, safe, "state.json")
}

function snapshotState(state) {
  return {
    savedAt: now(),
    target: state.target,
    meta: state.meta,
    metaAt: state.metaAt,
    sessionList: state.sessionList,
    lists: [...state.lists.entries()],
    messages: [...state.messages.entries()],
    details: [...state.details.entries()],
  }
}

function saveStateCache(state, config) {
  const file = cacheFile(config || state.config, state.target)
  if (!file) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(snapshotState(state)), "utf8")
  fs.renameSync(temp, file)
}

function loadStateCache(target, config) {
  const file = cacheFile(config, target)
  if (!file || !fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

function hydrateStateFromDisk(state, config) {
  const cached = loadStateCache(state.target, config || state.config)
  if (!cached) return false
  state.meta = cached.meta || undefined
  state.metaAt = cached.metaAt || 0
  state.sessionList = Array.isArray(cached.sessionList) ? cached.sessionList : []
  state.lists = new Map(Array.isArray(cached.lists) ? cached.lists : [])
  state.messages = new Map(Array.isArray(cached.messages) ? cached.messages : [])
  state.details = new Map(Array.isArray(cached.details) ? cached.details : [])
  state.offline = true
  state.offlineReason = "disk-cache-recovery"
  if (state.meta) {
    state.meta.cache = {
      ...(state.meta.cache || {}),
      source: "disk",
      cachedAt: cached.savedAt || state.metaAt || now(),
      warm: true,
    }
  }
  return true
}

module.exports = {
  cacheFile,
  saveStateCache,
  loadStateCache,
  hydrateStateFromDisk,
}
