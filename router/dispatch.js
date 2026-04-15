"use strict"

const { serveStatic } = require("./routes/static")
const { serveLanding } = require("./routes/landing")
const { handleControl } = require("./routes/control")
const { setTargetCookie } = require("./routes/control")
const { maybeServeCached } = require("./routes/cache")
const { proxyRequest } = require("./routes/proxy")
const { json } = require("./http")

const routes = [
  {
    id: "static",
    priority: 100,
    match: (ctx) => ctx.isStatic,
    handle: (ctx, req, res) => serveStatic(ctx, res),
  },
  {
    id: "landing",
    priority: 95,
    match: (ctx) => ctx.isLanding,
    handle: (ctx, req, res) => serveLanding(ctx, res),
  },
  {
    id: "control",
    priority: 90,
    match: (ctx) => ctx.isControl,
    handle: (ctx, req, res, states) => handleControl(ctx, req, res, states),
  },
  {
    id: "cache-hit",
    priority: 60,
    match: (ctx) => !ctx.isUpgrade && !ctx.isControl && ctx.target && ctx.state,
    handle: (ctx, req, res) => {
      if (!ctx.target) {
        json(res, 400, { error: "Invalid target host or port" })
        return
      }
      if (ctx.wantCookie) setTargetCookie(res, ctx.target)
      if (maybeServeCached(ctx, req, res)) return
      proxyRequest(ctx, req, res)
    },
  },
  {
    id: "proxy",
    priority: 0,
    match: () => true,
    handle: (ctx, req, res) => {
      if (!ctx.target) {
        json(res, 400, { error: "Invalid target host or port" })
        return
      }
      if (ctx.wantCookie) setTargetCookie(res, ctx.target)
      proxyRequest(ctx, req, res)
    },
  },
]

function dispatch(ctx, req, res, states) {
  for (const route of routes) {
    if (route.match(ctx)) {
      res.setHeader("X-OC-Route", route.id)
      route.handle(ctx, req, res, states)
      return
    }
  }
  json(res, 500, { error: "No matching route" })
}

module.exports = { routes, dispatch }
