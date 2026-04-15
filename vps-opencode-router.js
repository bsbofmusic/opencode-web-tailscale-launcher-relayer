"use strict"

const { createRouter } = require("./router/index")

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
