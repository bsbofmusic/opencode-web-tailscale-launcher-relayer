"use strict"

const { raw } = require("../http")
const { landingPage } = require("../pages")

function serveLanding(ctx, res) {
  const target = ctx.target || { host: "", port: "3000" }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
  res.end(landingPage(target))
}

module.exports = { serveLanding }
