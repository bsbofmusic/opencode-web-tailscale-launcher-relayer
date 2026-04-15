"use strict"

const { createRouter } = require("./index")

function startRouter(options) {
  return createRouter(options)
}

if (require.main === module) {
  startRouter()
}

module.exports = {
  createRouter,
  startRouter,
}
