"use strict"

const { EventEmitter } = require("events")
const { keyFor, now } = require("../util")

const emitter = new EventEmitter()
emitter.setMaxListeners(100)

function emitTargetEvent(target, event, payload) {
  emitter.emit("target-event", {
    targetKey: keyFor(target),
    event,
    payload: {
      ...(payload || {}),
      target,
      emittedAt: now(),
    },
  })
}

function subscribeTarget(target, handler) {
  const targetKey = keyFor(target)
  const wrapped = (message) => {
    if (!message || message.targetKey !== targetKey) return
    handler(message)
  }
  emitter.on("target-event", wrapped)
  return () => emitter.off("target-event", wrapped)
}

module.exports = {
  emitTargetEvent,
  subscribeTarget,
}
