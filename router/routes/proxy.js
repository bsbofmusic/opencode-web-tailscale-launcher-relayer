"use strict"

const http = require("http")
const { json, raw, relayHeaders } = require("../http")
const { sessionTimeoutPage, sessionSyncRuntime } = require("../pages")
const { clientSafeMode, clearLastReason, setLastReason, rememberActiveSession, requestDirectory, messageBypassReason, setClientHeads, setSyncState, syncAction, syncClientView } = require("../state")
const { runHeavy } = require("../heavy")
const { getAgent } = require("../warm")
const { cleanSearch, validClient, classifyError, isHeavyRequest, isSessionHtmlPath, cacheKey, now } = require("../util")
const { targetCookie } = require("../context")
const { saveStateCache } = require("../sync/disk-cache")

function upstreamAuth() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return null
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
}

function rewriteLocation(value, reqUrl, target) {
  if (!value || !value.startsWith("/")) return value
  const next = new URL(value, `http://${reqUrl.headersHost || "localhost"}`)
  next.searchParams.set("host", target.host)
  next.searchParams.set("port", target.port)
  const client = reqUrl.searchParams?.get?.("client")
  if (validClient(client)) next.searchParams.set("client", client)
  return `${next.pathname}${next.search}${next.hash}`
}

function proxyRequest(ctx, req, res) {
  const { target, state, client, reqUrl, config, wantCookie, priority } = ctx
  const heavy = req.method === "GET" && isHeavyRequest(reqUrl)
  const guardHtml = req.method === "GET" && isSessionHtmlPath(reqUrl.pathname)
  const htmlProxyTimeoutMs = config.htmlProxyTimeoutMs || 8000
  const recoveryHtmlTimeoutMs = config.recoveryHtmlTimeoutMs || 15000
  const htmlTimeoutMs = clientSafeMode(client) ? recoveryHtmlTimeoutMs : htmlProxyTimeoutMs
  const maxHeavy = config.maxHeavyRequestsPerTarget || 2
  const maxBg = Math.max(1, maxHeavy - 1)

  const runRequest = () => {
    const options = {
      hostname: target.host,
      port: Number(target.port),
      method: req.method,
      path: `${reqUrl.pathname}${cleanSearch(reqUrl.searchParams)}`,
      headers: {
        ...req.headers,
        host: `${target.host}:${target.port}`,
        connection: req.headers.upgrade ? "upgrade" : "keep-alive",
        "accept-encoding": "identity",
      },
      agent: getAgent(),
    }
    const auth = upstreamAuth()
    let finished = false
    delete options.headers.cookie
    delete options.headers["content-length"]
    if (auth && !options.headers.Authorization && !options.headers.authorization) options.headers.Authorization = auth
    const upstream = http.request(options, (up) => {
      if (finished) return
      const headers = { ...up.headers }
      const dir = requestDirectory(client, reqUrl)
      const msg = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
      const limit = Number(reqUrl.searchParams.get("limit") || "0")
      const reason = msg && dir && !reqUrl.searchParams.has("cursor") ? messageBypassReason(state, client, dir, decodeURIComponent(msg[1]), limit) : null
      Object.assign(headers, relayHeaders(priority, "proxy", reason || "proxy-pass", reason ? "bypass" : undefined))
      delete headers["content-security-policy"]
      delete headers["content-security-policy-report-only"]
      const location = rewriteLocation(headers.location, { headersHost: req.headers.host, searchParams: reqUrl.searchParams }, target)
      if (location) headers.location = location
      else delete headers.location
      if (wantCookie) headers["set-cookie"] = [`${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax`]
      const canStore = guardHtml || (req.method === "GET" && dir && !reqUrl.searchParams.has("cursor") && ((msg && (limit === 80 || limit === 200)) || reqUrl.pathname === "/session" || /^\/session\/[^/]+$/.test(reqUrl.pathname)))

      if (!canStore) {
        finished = true
        if (guardHtml && (up.statusCode || 0) >= 200 && (up.statusCode || 0) < 300) rememberActiveSession(client, reqUrl)
        if ((up.statusCode || 0) >= 200 && (up.statusCode || 0) < 300) clearLastReason(state, client)
        res.writeHead(up.statusCode || 502, headers)
        up.pipe(res)
        return
      }

      const chunks = []
      up.on("data", (chunk) => chunks.push(chunk))
      up.on("end", () => {
        if (finished) return
        finished = true
        const status = up.statusCode || 502
        let body = Buffer.concat(chunks).toString("utf8")
        const ok = status >= 200 && status < 300
        if (ok && msg) {
          const sessionID = decodeURIComponent(msg[1])
          state.messages.set(cacheKey(dir, sessionID, limit), {
            body,
            type: String(headers["content-type"] || "application/json"),
            status,
            at: now(),
            sessionID,
            directory: dir,
            limit,
          })
        }
        if (ok && reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true") {
          state.lists.set(`${dir}\n${Number(reqUrl.searchParams.get("limit") || "55")}`, {
            body,
            type: String(headers["content-type"] || "application/json"),
            status,
            at: now(),
          })
        }
        const detail = reqUrl.pathname.match(/^\/session\/([^/]+)$/)
        if (ok && detail && dir) {
          state.details.set(`${dir}\n${decodeURIComponent(detail[1])}`, {
            body,
            type: String(headers["content-type"] || "application/json"),
            status,
            at: now(),
          })
        }
        if (guardHtml && ok) {
          rememberActiveSession(client, reqUrl)
          syncClientView(state, client)
          if (client.remoteHead?.sessionID && client.remoteHead.sessionID === client.activeSessionID && client.remoteHead.directory === client.activeDirectory) {
            setClientHeads(state, client, client.remoteHead, client.remoteHead)
            setSyncState(client, "live", null, "noop")
            client.refreshFailures = 0
          }
          if (String(headers["content-type"] || "").includes("text/html")) {
            body = injectRuntime(body)
            delete headers["transfer-encoding"]
            headers["content-length"] = Buffer.byteLength(body, "utf8")
          }
          headers["x-oc-relay-sync-state"] = client.syncState || (state.offline ? "offline" : "live")
          headers["x-oc-relay-stale-reason"] = client.staleReason || ""
          headers["x-oc-relay-action"] = syncAction(state, client)
        }
        if (ok) {
          state.offline = false
          state.offlineReason = null
          clearLastReason(state, client)
          saveStateCache(state, config)
        }
        res.writeHead(status, headers)
        res.end(body)
      })
    })
    if (guardHtml) {
      upstream.setTimeout(htmlTimeoutMs, () => {
        if (finished) return
        finished = true
        upstream.destroy(new Error(`Session HTML timed out after ${htmlTimeoutMs}ms`))
        if (client.lastAction === "soft-refresh") client.refreshFailures = (client.refreshFailures || 0) + 1
        setLastReason(state, client, "html-timeout")
        raw(res, 504, sessionTimeoutPage(target, reqUrl, htmlTimeoutMs), "text/html", relayHeaders(priority, "fallback", "html-timeout"))
      })
    }
    upstream.on("error", (err) => {
      if (finished) return
      finished = true
      if (res.headersSent || res.writableEnded || res.destroyed) return
      if (guardHtml && /timed out/i.test(classifyError(err, ""))) {
        if (client.lastAction === "soft-refresh") client.refreshFailures = (client.refreshFailures || 0) + 1
        setLastReason(state, client, "html-timeout")
        raw(res, 504, sessionTimeoutPage(target, reqUrl, htmlTimeoutMs), "text/html", relayHeaders(priority, "fallback", "html-timeout"))
        return
      }
      state.offline = true
      state.offlineReason = err.message
      setLastReason(state, client, "upstream-request-failed")
      json(res, 502, { error: err.message }, relayHeaders(priority, "error", "upstream-request-failed"))
    })
    req.on("data", (chunk) => upstream.write(chunk))
    req.on("end", () => upstream.end())
  }
  if (heavy) {
    runHeavy(state, runRequest, priority, maxHeavy, maxBg).catch((err) => {
      if (res.headersSent || res.writableEnded || res.destroyed) return
      setLastReason(state, client, "upstream-request-failed")
      json(res, 502, { error: classifyError(err, "Upstream request failed") }, relayHeaders(priority, "error", "upstream-request-failed"))
    })
    return
  }
  runRequest()
}

function injectRuntime(body) {
  const tag = sessionSyncRuntime()
  if (body.includes("oc-tailnet-sync-runtime")) return body
  if (body.includes("</body>")) return body.replace("</body>", `${tag}</body>`)
  return `${body}${tag}`
}

module.exports = { proxyRequest, rewriteLocation }
