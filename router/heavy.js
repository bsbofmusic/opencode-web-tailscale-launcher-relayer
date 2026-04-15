"use strict"

const { backgroundWarmPaused, setLastReason } = require("./state")
const { classifyError } = require("./util")

const defaults = {
  maxHeavyRequestsPerTarget: 2,
}

function canRunHeavy(state, priority, maxHeavy, maxBackgroundHeavy) {
  const limit = maxHeavy || defaults.maxHeavyRequestsPerTarget
  const backgroundLimit = maxBackgroundHeavy || Math.max(1, limit - 1)
  if (state.heavyActive >= limit) return false
  if (priority === "background" && backgroundWarmPaused(state)) return false
  if (priority === "background" && state.heavyBackgroundActive >= backgroundLimit) return false
  return true
}

function drainHeavy(state, maxHeavy, maxBackgroundHeavy) {
  while (state.heavyQueue.length && canRunHeavy(state, "foreground", maxHeavy, maxBackgroundHeavy)) {
    state.heavyQueue.shift()()
  }
  while (!state.heavyQueue.length && state.heavyBackgroundQueue.length && canRunHeavy(state, "background", maxHeavy, maxBackgroundHeavy)) {
    state.heavyBackgroundQueue.shift()()
  }
  if (!state.heavyQueue.length && !state.heavyBackgroundQueue.length) pumpBackground(state)
}

function runHeavy(state, work, priority, maxHeavy, maxBackgroundHeavy) {
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
        drainHeavy(state, maxHeavy, maxBackgroundHeavy)
      })
  }
  if (canRunHeavy(state, mode, maxHeavy, maxBackgroundHeavy) && (mode === "foreground" || !state.heavyQueue.length)) {
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
  if (backgroundWarmPaused(state)) return
  const next = state.backgroundQueue.shift()
  if (!next) return
  state.backgroundActive += 1
  Promise.resolve()
    .then(next.run)
    .catch((err) => {
      state.lastError = classifyError(err, "Background cache failed")
      setLastReason(state, null, "background-cache-failed")
    })
    .finally(() => {
      state.backgroundActive -= 1
      state.backgroundKeys.delete(next.key)
      if (!state.backgroundQueue.length) {
        const { syncClients } = require("./warm")
        syncClients(state)
      }
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

module.exports = {
  canRunHeavy,
  drainHeavy,
  runHeavy,
  pumpBackground,
  enqueueBackground,
}
