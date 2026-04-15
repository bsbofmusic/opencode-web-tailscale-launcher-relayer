"use strict"

// Backward-compatible alias for older test/dev entry points.
const { createRouter, startRouter } = require("./vps-opencode-router")

module.exports = {
  createRouter,
  startRouter,
}
