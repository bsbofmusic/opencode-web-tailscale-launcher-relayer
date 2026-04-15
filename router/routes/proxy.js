"use strict"

const http = require("http")
const { json, raw, relayHeaders } = require("../http")
const { sessionTimeoutPage, sessionSyncRuntime } = require("../pages")
const { clientSafeMode, clearLastReason, setLastReason, rememberActiveSession, requestDirectory, messageBypassReason, setClientHeads, setSyncState, syncAction, syncClientView } = require("../state")
const { runHeavy } = require("../heavy")
const { getAgent, cacheMessages, cacheProjectCurrent, fetchJsonWith, fetchWorkspaceRoot, rememberWorkspaceSessions, buildWorkspaceRoots, projectInventory } = require("../warm")
const { enqueueBackground } = require("../heavy")
const { cleanSearch, validClient, classifyError, isHeavyRequest, isSessionHtmlPath, cacheKey, now, bootstrapKey } = require("../util")
const { targetCookie } = require("../context")
const { saveStateCache } = require("../sync/disk-cache")
const { emitTargetEvent } = require("../sync/bus")

function upstreamAuth() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return null
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
}

function extractAssetPaths(html) {
  const paths = new Set()
  for (const match of html.matchAll(/<(?:script|link)\b[^>]+(?:src|href)="([^"]+)"/gi)) {
    const value = match[1] || ''
    if (/^\/assets\//.test(value)) paths.add(value)
  }
  return [...paths]
}

function assetDependencies(buffer, headers) {
  const type = String(headers['content-type'] || '')
  if (!/javascript|css/i.test(type)) return []
  let text = ''
  try {
    const encoding = String(headers['content-encoding'] || '')
    const body = /gzip/i.test(encoding) ? require('zlib').gunzipSync(buffer) : buffer
    text = body.toString('utf8')
  } catch {
    return []
  }
  const deps = new Set()
  for (const match of text.matchAll(/\/assets\/[A-Za-z0-9._-]+/g)) deps.add(match[0])
  return [...deps]
}

function warmAsset(state, target, assetPath, depth = 0) {
  if (state.assets.has(assetPath)) return
  const headers = { Accept: '*/*', 'accept-encoding': 'gzip, deflate, br', Connection: 'close' }
  const auth = upstreamAuth()
  if (auth) headers.Authorization = auth
  const upstream = http.request({ hostname: target.host, port: Number(target.port), method: 'GET', path: assetPath, headers, agent: false }, (up) => {
    const chunks = []
    up.on('data', (chunk) => chunks.push(chunk))
    up.on('end', () => {
      const status = up.statusCode || 502
      if (status < 200 || status >= 300) return
      const buffer = Buffer.concat(chunks)
      state.assets.set(assetPath, {
        body: buffer,
        status,
        at: now(),
        headers: assetHeaders(up.headers),
      })
      if (depth < 1) {
        for (const dep of assetDependencies(buffer, up.headers)) {
          warmAsset(state, target, dep, depth + 1)
        }
      }
    })
  })
  upstream.on('error', () => {})
  upstream.end()
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

function assetHeaders(headers) {
  return {
    ...(headers['content-type'] ? { 'content-type': headers['content-type'] } : {}),
    ...(headers['content-encoding'] ? { 'content-encoding': headers['content-encoding'] } : {}),
    ...(headers.etag ? { etag: headers.etag } : {}),
    ...(headers['last-modified'] ? { 'last-modified': headers['last-modified'] } : {}),
    'cache-control': 'public, max-age=31536000, immutable',
  }
}

function parseJsonArray(body) {
  try {
    const rows = JSON.parse(String(body || "[]"))
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function rewriteProjectList(state, body) {
  const meta = Array.isArray(state.meta?.projects?.inventory) ? state.meta.projects.inventory : null
  const built = buildWorkspaceRoots(state.inventory, state.sessionList, state.config?.extraRoots)
  const seen = new Set()
  const roots = []
  for (const dir of [...built, ...((state.meta?.projects?.roots || []).filter(Boolean))]) {
    const key = String(dir || "").toLowerCase()
    if (!dir || seen.has(key)) continue
    seen.add(key)
    roots.push(dir)
  }
  const source = meta && meta.length ? meta : parseJsonArray(body)
  return JSON.stringify(projectInventory(source, roots))
}

function currentProject(state, directory) {
  const list = Array.isArray(state.meta?.projects?.inventory) ? state.meta.projects.inventory : state.inventory
  const hit = (Array.isArray(list) ? list : []).find((item) => String(item?.worktree || '').toLowerCase() === String(directory || '').toLowerCase())
  if (hit) return hit
  const extra = Array.isArray(state.config?.extraRoots) ? state.config.extraRoots : []
  if (!extra.some((item) => String(item || '').toLowerCase() === String(directory || '').toLowerCase())) return null
  // Synthetic project: display-only. Must not feed back into state.meta or session latest.
  return {
    id: `relay:${Buffer.from(String(directory), 'utf8').toString('base64').replace(/=+$/g, '')}`,
    worktree: directory,
    sandboxes: [],
  }
}

function parseJsonArray(body) {
  try {
    const rows = JSON.parse(body || "[]")
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}


function proxyRequest(ctx, req, res) {
  const { target, state, client, reqUrl, config, wantCookie, priority } = ctx
  const directory = requestDirectory(client, reqUrl)
  const projectMatch = reqUrl.pathname.match(/^\/project\/([^/]+)$/)
  const projectID = projectMatch ? decodeURIComponent(projectMatch[1]) : null
  const syntheticProject = directory ? currentProject(state, directory) : null
  if (req.method === "GET" && reqUrl.pathname === "/project/current" && syntheticProject?.id && String(syntheticProject.id).startsWith("relay:")) {
    clearLastReason(state, client)
    json(res, 200, syntheticProject, relayHeaders(priority, "proxy", "synthetic-project-current"))
    return
  }
  if (req.method === "PATCH" && projectID && String(projectID).startsWith("relay:") && directory) {
    const item = syntheticProject && syntheticProject.id === projectID ? syntheticProject : {
      id: projectID,
      worktree: directory,
      sandboxes: [],
    }
    clearLastReason(state, client)
    json(res, 200, item, relayHeaders(priority, "proxy", "synthetic-project-open"))
    return
  }
  const heavy = req.method === "GET" && isHeavyRequest(reqUrl)
  const promptRequest = req.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(reqUrl.pathname)
  const guardHtml = req.method === "GET" && isSessionHtmlPath(reqUrl.pathname)
  const assetRequest = req.method === "GET" && /^\/(assets\/|favicon|site\.webmanifest)/.test(reqUrl.pathname)
  const messageRequest = req.method === "GET" && /^\/session\/[^/]+\/message$/.test(reqUrl.pathname)
  const promptMatch = req.method === "POST" ? reqUrl.pathname.match(/^\/session\/([^/]+)\/prompt_async$/) : null
  const bootstrapRequest = req.method === "GET" && /^\/(path|project|project\/current|session\/status|global\/config|provider|config)$/.test(reqUrl.pathname)
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
        connection: req.headers.upgrade ? "upgrade" : ((guardHtml || assetRequest || messageRequest || bootstrapRequest) ? "close" : "keep-alive"),
        "accept-encoding": assetRequest ? String(req.headers['accept-encoding'] || 'gzip, deflate, br') : "identity",
      },
      agent: (guardHtml || assetRequest || messageRequest || bootstrapRequest) ? false : getAgent(),
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
      const reason = msg && dir && !reqUrl.searchParams.has("cursor") && !reqUrl.searchParams.has("before") ? messageBypassReason(state, client, dir, decodeURIComponent(msg[1]), limit) : null
      Object.assign(headers, relayHeaders(priority, "proxy", reason || "proxy-pass", reason ? "bypass" : undefined))
      if (msg && dir && !reqUrl.searchParams.has("cursor") && !reqUrl.searchParams.has("before")) {
        const sessionID = decodeURIComponent(msg[1])
        headers["X-OC-Message-Cache"] = reason ? "bypass" : "miss"
        headers["X-OC-Message-Requested-Session"] = sessionID
        headers["X-OC-Message-Active-Session"] = client?.activeSessionID || ""
        headers["X-OC-Message-View-Session"] = client?.view?.sessionID || ""
        headers["X-OC-Message-Latest-Session"] = state.meta?.sessions?.latest?.id || ""
      }
      delete headers["content-security-policy"]
      delete headers["content-security-policy-report-only"]
      const location = rewriteLocation(headers.location, { headersHost: req.headers.host, searchParams: reqUrl.searchParams }, target)
      if (location) headers.location = location
      else delete headers.location
      if (wantCookie) headers["set-cookie"] = [`${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax`]
      const canStore =
        guardHtml ||
        assetRequest ||
        (req.method === "GET" && /^\/(global\/config|provider|config|session\/status|project|path)$/.test(reqUrl.pathname)) ||
        (req.method === "GET" && dir && !reqUrl.searchParams.has("cursor") && !reqUrl.searchParams.has("before") && ((msg && (limit === 80 || limit === 200)) || reqUrl.pathname === "/session" || /^\/session\/[^/]+$/.test(reqUrl.pathname)))

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
        const rawBody = Buffer.concat(chunks)
        let body = assetRequest ? rawBody : rawBody.toString("utf8")
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
            source: "proxy",
            sourceAt: now(),
          })
        }
        if (ok && promptRequest) {
          const sessionID = promptMatch ? decodeURIComponent(promptMatch[1]) : null
          const directory = requestDirectory(client, reqUrl) || [...state.clients.values()].find((peer) => {
            const view = peer.view || (peer.activeSessionID && peer.activeDirectory ? { sessionID: peer.activeSessionID, directory: peer.activeDirectory } : null)
            return view?.sessionID === sessionID && view.directory
          })?.activeDirectory || (state.meta?.sessions?.latest?.id === sessionID ? state.meta?.sessions?.latest?.directory : null)
          if (sessionID && directory) {
            for (const peer of state.clients.values()) {
              const view = peer.view || (peer.activeSessionID && peer.activeDirectory ? { sessionID: peer.activeSessionID, directory: peer.activeDirectory } : null)
              if (!view) continue
              if (view.sessionID !== sessionID || view.directory !== directory) continue
              peer.localSubmitUntil = Date.now() + 8000
              setSyncState(peer, "stale", "peer-submit", peer.lastAction || "noop")
              emitTargetEvent(state.target, "sync-stale", {
                client: peer.id,
                sessionID,
                directory,
                reason: "peer-submit",
                action: peer.lastAction || "noop",
                state: peer.syncState,
                version: state.syncVersion,
                timestamp: Date.now(),
              })
            }
          }
        }
        if (ok && assetRequest) {
          state.assets.set(reqUrl.pathname, {
            body: rawBody,
            status,
            at: now(),
            headers: assetHeaders(headers),
          })
        }
        if (ok && reqUrl.pathname === "/project") {
          body = rewriteProjectList(state, body)
          delete headers["transfer-encoding"]
          headers["content-length"] = Buffer.byteLength(body, "utf8")
        }
        if (ok && reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true") {
          rememberWorkspaceSessions(state, dir, parseJsonArray(body), Number(reqUrl.searchParams.get("limit") || "55"), config, now())
        }
        if (ok && /^\/(global\/config|provider|config|session\/status|project|path)$/.test(reqUrl.pathname)) {
          state.bootstrap.set(bootstrapKey(reqUrl.pathname, dir), {
            body,
            type: String(headers["content-type"] || "application/json"),
            status,
            at: now(),
          })
        }
        const detail = reqUrl.pathname.match(/^\/session\/([^/]+)$/)
        if (ok && detail && dir) {
          state.details.set(`${dir}\n${decodeURIComponent(detail[1])}`, {
            body, type: String(headers["content-type"] || "application/json"), status, at: now(),
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
            for (const assetPath of extractAssetPaths(body)) warmAsset(state, target, assetPath)
            if (client.activeDirectory && client.activeSessionID) {
              const warmBootstrap = (path, keyDir = client.activeDirectory) => enqueueBackground(state, `bootstrap\n${path}\n${keyDir || ''}`, async () => {
                const query = keyDir ? `${path}?directory=${encodeURIComponent(keyDir)}` : path
                const data = await fetchJsonWith(target, query, { state }, config)
                const body = path === '/project' ? rewriteProjectList(state, data.text) : data.text
                state.bootstrap.set(bootstrapKey(path, keyDir), {
                  body,
                  type: String(data.headers?.['content-type'] || 'application/json'),
                  status: 200,
                  at: now(),
                })
              })
              warmBootstrap('/global/config', '')
              warmBootstrap('/path', '')
              warmBootstrap('/project', '')
              warmBootstrap('/provider', '')
              warmBootstrap('/config')
              warmBootstrap('/provider')
              warmBootstrap('/session/status')
              enqueueBackground(state, `project\n${client.activeDirectory}`, async () => {
                await cacheProjectCurrent(state, target, client.activeDirectory, config)
              })
              enqueueBackground(state, `workspace-list\n${client.activeDirectory}`, async () => {
                await fetchWorkspaceRoot(state, target, client.activeDirectory, config)
              })
              enqueueBackground(state, `message\n${client.activeDirectory}\n${client.activeSessionID}\n80`, async () => {
                await cacheMessages(state, target, client.activeDirectory, client.activeSessionID, 80, config)
              })
            }
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
    if (req.method === "GET" || req.method === "HEAD") {
      upstream.end()
    } else {
      req.on("data", (chunk) => upstream.write(chunk))
      req.on("end", () => upstream.end())
    }
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
