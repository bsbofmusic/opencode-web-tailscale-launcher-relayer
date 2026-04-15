"use strict"

const { parseCookies, validClient, validIp, validPort, parseTarget, isSessionHtmlPath, isHeavyRequest, messageRequestInfo, createClientID } = require("./util")
const { ensureState, ensureClientState, clientSafeMode, requestDirectory, messageBypass, relayPriority, backgroundWarmPaused } = require("./state")
const { fresh } = require("./util")

const targetCookie = "oc_target"

function getTarget(reqUrl, headers, options) {
  const opts = options || {}
  const cookies = opts.useCookie === false ? {} : parseCookies(headers.cookie)
  const fromCookie = cookies[targetCookie]?.split(":")
  const host = reqUrl.searchParams.get("host") || fromCookie?.[0] || ""
  const port = reqUrl.searchParams.get("port") || fromCookie?.[1] || "3000"
  if (!host) return opts.allowEmpty ? { host: "", port } : undefined
  return parseTarget(host, port)
}

function getClientID(reqUrl, options) {
  const opts = options || {}
  const value = reqUrl.searchParams.get("client") || ""
  if (validClient(value)) return value
  if (opts.allowGenerated) return createClientID()
  return "_shared"
}

function buildContext(req, reqUrl, states, config) {
  const cfg = config || {}
  const pathname = reqUrl.pathname

  const isLanding = !pathname || pathname === "/" || pathname === "/index.html" || pathname === "/__landing"
  const isStatic = pathname === "/favicon.ico" || pathname === "/site.webmanifest"
  const isControl = pathname.startsWith("/__oc/")
  const isUpgrade = Boolean(req.headers.upgrade && req.headers.upgrade.toLowerCase() === "websocket")

  const ctx = {
    req,
    reqUrl,
    pathname,
    isLanding,
    isStatic,
    isControl,
    isUpgrade,
    controlRoute: isControl ? pathname.slice(5) : null,
    target: null,
    state: null,
    client: null,
    wantCookie: reqUrl.searchParams.has("host") || reqUrl.searchParams.has("port"),
    isSessionHtml: false,
    isHeavy: false,
    shouldBypass: false,
    bypassReason: null,
    cacheHit: false,
    cacheEntry: null,
    priority: "foreground",
    isMobile: /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(String(req.headers["user-agent"] || "")),
    resumeSafe: false,
    config: cfg,
  }

  if (isStatic || isLanding) {
    if (isLanding) {
      ctx.target = getTarget(reqUrl, req.headers, { allowEmpty: true, useCookie: false }) || { host: "", port: "3000" }
    }
    return ctx
  }

  // These control routes intentionally stay outside per-target/per-client state.
  // The original router answered them before target resolution, which avoids
  // creating a synthetic shared client that can accidentally re-enter resume-safe.
  if (pathname === "/__oc/clear" || pathname === "/__oc/healthz") {
    return ctx
  }

  const target = getTarget(reqUrl, req.headers)
  if (!target) return ctx

  ctx.target = target
  ctx.state = ensureState(states, target, cfg)

  const allowGenerated = pathname === "/__oc/launch"
  ctx.client = ensureClientState(ctx.state, getClientID(reqUrl, { allowGenerated }), cfg)
  ctx.resumeSafe = clientSafeMode(ctx.client)

  if (!isControl && !isUpgrade && req.method === "GET") {
    ctx.isSessionHtml = isSessionHtmlPath(pathname)
    ctx.isHeavy = isHeavyRequest(reqUrl)
    ctx.priority = relayPriority(reqUrl, ctx.client)

    const directory = requestDirectory(ctx.client, reqUrl)
    const msgInfo = messageRequestInfo(reqUrl)

    if (msgInfo && directory && !reqUrl.searchParams.has("cursor")) {
      if (messageBypass(ctx.state, ctx.client, directory, msgInfo.sessionID, msgInfo.limit)) {
        ctx.shouldBypass = true
        ctx.bypassReason = "bypass"
      }
    }
  }

  return ctx
}

module.exports = {
  targetCookie,
  getTarget,
  getClientID,
  buildContext,
}
