"use strict"

const fs = require("fs")
const path = require("path")
const { keyFor, now } = require("../util")

const pendingWrites = new Map()
const scheduledWrites = new Map()

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
    inventory: state.inventory,
    inventoryAt: state.inventoryAt,
    sessionList: state.sessionList,
    workspaceSessions: [...state.workspaceSessions.entries()],
    lists: [...state.lists.entries()],
    messages: [...state.messages.entries()],
    details: [...state.details.entries()],
    projects: [...state.projects.entries()],
    bootstrap: [...state.bootstrap.entries()],
    shellHtml: state.shellHtml,
  }
}

function saveStateCache(state, config) {
  const file = cacheFile(config || state.config, state.target)
  if (!file) return
  pendingWrites.set(file, snapshotState(state))
  if (scheduledWrites.has(file)) return
  const timer = setTimeout(() => {
    scheduledWrites.delete(file)
    const snapshot = pendingWrites.get(file)
    if (!snapshot) return
    pendingWrites.delete(file)
    const temp = `${file}.tmp`
    let body
    try {
      body = JSON.stringify(snapshot)
    } catch {
      return
    }
    fs.promises.mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.promises.writeFile(temp, body, "utf8"))
      .then(() => fs.promises.rename(temp, file))
      .catch(() => {})
  }, 150)
  timer.unref?.()
  scheduledWrites.set(file, timer)
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
  state.inventory = Array.isArray(cached.inventory) ? cached.inventory : []
  state.inventoryAt = cached.inventoryAt || 0
  state.sessionList = Array.isArray(cached.sessionList) ? cached.sessionList : []
  state.workspaceSessions = new Map(Array.isArray(cached.workspaceSessions) ? cached.workspaceSessions : [])
  state.lists = new Map(Array.isArray(cached.lists) ? cached.lists : [])
  state.messages = new Map(Array.isArray(cached.messages) ? cached.messages : [])
  state.details = new Map(Array.isArray(cached.details) ? cached.details : [])
  state.projects = new Map(Array.isArray(cached.projects) ? cached.projects : [])
  state.bootstrap = new Map(Array.isArray(cached.bootstrap) ? cached.bootstrap : [])
  state.assets = new Map()
  state.shellHtml = cached.shellHtml || null
  state.offline = false
  state.offlineReason = null
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
