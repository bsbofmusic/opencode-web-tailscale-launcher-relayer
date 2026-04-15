const http = require("http")

const bindHost = process.env.OPENCODE_ROUTER_HOST || "127.0.0.1"
const bindPort = Number(process.env.OPENCODE_ROUTER_PORT || "33102")
const targetCookie = "oc_target"
const maxSessions = 80
const maxProjects = 12
const inspectTimeoutMs = 5000
const inspectCacheMs = 3000

const inspectCache = new Map()

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
}

function validIp(value) {
  const parts = value.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!part) return false
    if (!part.split("").every((char) => char >= "0" && char <= "9")) return false
    const num = Number(part)
    return Number.isInteger(num) && num >= 0 && num <= 255
  })
}

function validPort(value) {
  return /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) < 65536
}

function parseCookies(raw) {
  return (raw || "").split(/;\s*/).reduce((out, item) => {
    const i = item.indexOf("=")
    if (i === -1) return out
    out[item.slice(0, i)] = item.slice(i + 1)
    return out
  }, {})
}

function parseTarget(host, port) {
  if (!host) return
  if (!validIp(host)) return
  const nextPort = String(port || "3000")
  if (!validPort(nextPort)) return
  return { host, port: nextPort }
}

function getTarget(reqUrl, headers, options) {
  const opts = options || {}
  const cookies = opts.useCookie === false ? {} : parseCookies(headers.cookie)
  const fromCookie = cookies[targetCookie]?.split(":")
  const host = reqUrl.searchParams.get("host") || fromCookie?.[0] || ""
  const port = reqUrl.searchParams.get("port") || fromCookie?.[1] || "3000"
  if (!host) return opts.allowEmpty ? { host: "", port } : undefined
  return parseTarget(host, port)
}

function setTargetCookie(res, target) {
  res.setHeader("Set-Cookie", `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax`)
}

function clearTargetCookie(res) {
  res.setHeader("Set-Cookie", `${targetCookie}=; Path=/; Max-Age=0; SameSite=Lax`)
}

function json(res, code, body, extra) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(extra || {}),
  })
  res.end(JSON.stringify(body))
}

async function fetchJson(target, path) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), inspectTimeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(`http://${target.host}:${target.port}${path}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`Upstream returned ${res.status}`)
    return { data: await res.json(), latencyMs: Date.now() - start }
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error(`Timed out after ${inspectTimeoutMs}ms`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

function encodeDir(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function latest(items) {
  return [...items].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))[0]
}

function uniqueDirectories(items) {
  const seen = new Set()
  return items
    .map((item) => item?.directory)
    .filter((dir) => {
      if (!dir || seen.has(dir)) return false
      seen.add(dir)
      return true
    })
    .slice(0, maxProjects)
}

function classifyError(err, fallback) {
  const text = err instanceof Error ? err.message : String(err)
  return text || fallback
}

async function inspectTarget(target) {
  const result = {
    target,
    source: {
      kind: "cli",
      label: "Global CLI service",
    },
    health: {
      ok: false,
      healthy: false,
      version: null,
      latencyMs: null,
      error: null,
    },
    sessions: {
      ok: false,
      count: 0,
      directories: [],
      latest: null,
      error: null,
    },
    ready: false,
  }

  try {
    const { data, latencyMs } = await fetchJson(target, "/global/health")
    result.health = {
      ok: true,
      healthy: data?.healthy === true,
      version: data?.version || null,
      latencyMs,
      error: data?.healthy === true ? null : "OpenCode unhealthy",
    }
  } catch (err) {
    result.health.error = classifyError(err, "Health check failed")
    return result
  }

  try {
    const { data } = await fetchJson(target, `/session?limit=${maxSessions}`)
    const list = Array.isArray(data) ? data : []
    const root = latest(list)
    result.sessions = {
      ok: true,
      count: list.length,
      directories: uniqueDirectories(list),
      latest: root
        ? {
            id: root.id || null,
            title: root.title || null,
            directory: root.directory || null,
          }
        : null,
      error: list.length ? null : "Target is online but has no historical sessions",
    }
  } catch (err) {
    result.sessions.error = classifyError(err, "Session scan failed")
    return result
  }

  result.ready = Boolean(result.health.ok && result.health.healthy && result.sessions.ok && result.sessions.latest && result.sessions.latest.directory)
  return result
}

function inspectKey(target) {
  return `${target.host}:${target.port}`
}

function inspectCached(target) {
  const key = inspectKey(target)
  const now = Date.now()
  const hit = inspectCache.get(key)
  if (hit?.value && now - hit.time < inspectCacheMs) return Promise.resolve(hit.value)
  if (hit?.promise) return hit.promise
  const promise = inspectTarget(target)
    .then((value) => {
      inspectCache.set(key, { time: Date.now(), value })
      return value
    })
    .catch((err) => {
      inspectCache.delete(key)
      throw err
    })
  inspectCache.set(key, { time: now, promise, value: hit?.value })
  return promise
}

function launchPage(payload) {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Launching</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #13233e 0, #08111d 46%); color: #eef4ff; font: 15px/1.5 Inter, "Segoe UI", sans-serif; }
    main { width: min(620px, 100%); border: 1px solid #20314b; border-radius: 22px; padding: 22px; background: rgba(13, 21, 35, .94); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { margin: 0; color: #8fa6c7; }
    code { color: #d3e3ff; word-break: break-all; }
    .line { margin-top: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Launching Remote OpenCode</h1>
    <p>Preparing server state, then entering the real OpenCode session.</p>
    <div class="line"><code id="status">Preparing...</code></div>
  </main>
  <script>
    const payload = ${json}
    const status = document.getElementById('status')
    const serverKey = 'opencode.global.dat:server'
    const defaultServerKey = 'opencode.settings.dat:defaultServerUrl'
    const origin = location.origin
    function read(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} } }
    function write(key, value) { localStorage.setItem(key, JSON.stringify(value)) }
    function serverKeys() {
      const keys = [origin]
      if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') keys.unshift('local')
      return Array.from(new Set(keys))
    }
    function seed(meta) {
      const data = read(serverKey)
      if (!Array.isArray(data.list)) data.list = []
      if (!data.projects || typeof data.projects !== 'object') data.projects = {}
      if (!data.lastProject || typeof data.lastProject !== 'object') data.lastProject = {}
      const seen = new Set()
      const merged = []
      ;(meta.sessions.directories || []).forEach(function (dir, index) {
        if (!dir || seen.has(dir)) return
        seen.add(dir)
        merged.push({ worktree: dir, expanded: index === 0 })
      })
      serverKeys().forEach(function (key) {
        data.projects[key] = merged
        if (meta.sessions.latest && meta.sessions.latest.directory) data.lastProject[key] = meta.sessions.latest.directory
      })
      localStorage.setItem(defaultServerKey, origin)
      write(serverKey, data)
    }
    if (!payload.ready || !payload.sessions || !payload.sessions.latest || !payload.sessions.latest.directory || !payload.sessions.latest.id) {
      status.textContent = payload.health && payload.health.error ? payload.health.error : 'Target is not ready'
    } else {
      seed(payload)
      status.textContent = 'Ready. Redirecting...'
      const next = '/' + payload.launch.directory + '/session/' + encodeURIComponent(payload.launch.sessionID)
        + '?host=' + encodeURIComponent(payload.target.host)
        + '&port=' + encodeURIComponent(payload.target.port)
      location.replace(next)
    }
  </script>
</body>
</html>`
}

function rewriteLocation(value, reqUrl, target) {
  if (!value || !value.startsWith("/")) return value
  const next = new URL(value, `http://${reqUrl.headersHost || "localhost"}`)
  next.searchParams.set("host", target.host)
  next.searchParams.set("port", target.port)
  return `${next.pathname}${next.search}${next.hash}`
}

function landing(target) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Tailnet Router</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #13233e 0, #08111d 46%); color: #eef4ff; font: 15px/1.5 Inter, "Segoe UI", sans-serif; }
    main { width: min(760px, 100%); background: rgba(13, 21, 35, .94); border: 1px solid #20314b; border-radius: 22px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0; font-size: 30px; line-height: 1.12; }
    p { margin: 10px 0 0; color: #8fa6c7; }
    .grid { display: grid; grid-template-columns: 1fr 110px; gap: 12px; margin-top: 18px; }
    label { display: block; margin: 0 0 6px; color: #8fa6c7; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
    input { width: 100%; height: 48px; border-radius: 12px; border: 1px solid #334155; background: #020617; color: #eef4ff; padding: 0 14px; font-size: 15px; }
    .actions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
    button { display: inline-flex; align-items: center; justify-content: center; padding: 11px 15px; border-radius: 12px; border: 1px solid #334155; background: #101b2b; color: #eef4ff; cursor: pointer; font: inherit; }
    .primary { background: linear-gradient(180deg, #3d8cff, #2c7dff); border-color: #3279e7; }
    .status { margin-top: 14px; color: #8fa6c7; min-height: 20px; }
    .meta { margin-top: 14px; padding: 14px; border: 1px solid #20314b; border-radius: 14px; background: rgba(7, 12, 22, .92); display: grid; gap: 10px; }
    .line { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .k { color: #8fa6c7; min-width: 108px; }
    .ok { color: #79e29b; }
    .bad { color: #f1bc65; }
    code { color: #d3e3ff; word-break: break-all; }
    ul { margin: 6px 0 0 18px; padding: 0; color: #d3e3ff; }
    @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } .k { min-width: auto; } }
  </style>
</head>
<body>
  <main>
    <h1>OpenCode Tailnet Router</h1>
    <p>Enter the Tailscale IPv4 and port for a machine already running the CLI version of OpenCode web.</p>
    <div class="grid">
      <div><label for="host">Tailscale IPv4</label><input id="host" value="${escapeHtml(target.host)}" placeholder="100.x.x.x"></div>
      <div><label for="port">Port</label><input id="port" value="${escapeHtml(target.port)}" placeholder="3000"></div>
    </div>
    <div class="actions">
      <button id="open" class="primary" type="button">Open Remote OpenCode</button>
      <button id="check" type="button">Check</button>
      <button id="clear" type="button">Clear</button>
    </div>
    <div id="status" class="status"></div>
    <div id="meta" class="meta">Enter a target and click Check.</div>
  </main>
  <script>
    const host = document.getElementById('host')
    const port = document.getElementById('port')
    const status = document.getElementById('status')
    const meta = document.getElementById('meta')
    function validIp(value) {
      const parts = value.split('.')
      if (parts.length !== 4) return false
      return parts.every(function (part) {
        if (!part) return false
        if (!part.split('').every(function (char) { return char >= '0' && char <= '9' })) return false
        const num = Number(part)
        return Number.isInteger(num) && num >= 0 && num <= 255
      })
    }
    function cleanPort(value) {
      const chars = value.split('').filter(function (char) { return char >= '0' && char <= '9' }).join('')
      return chars || '3000'
    }
    function target() {
      const ip = host.value.trim()
      const p = cleanPort(port.value.trim() || '3000')
      if (!validIp(ip)) throw new Error('Invalid Tailscale IPv4')
      return { host: ip, port: p }
    }
    function renderMeta(data) {
      const healthOk = data.health && data.health.ok
      const sessionsOk = data.sessions && data.sessions.ok
      const healthText = healthOk ? '<span class="ok">healthy</span>' : '<span class="bad">' + (data.health && data.health.error ? data.health.error : 'unreachable') + '</span>'
      const versionText = data.health && data.health.version ? data.health.version : 'unknown'
      const latencyText = data.health && typeof data.health.latencyMs === 'number' ? data.health.latencyMs + ' ms' : 'n/a'
      const latestTitle = sessionsOk && data.sessions.latest ? (data.sessions.latest.title || data.sessions.latest.id || 'none') : 'none'
      const latestDir = sessionsOk && data.sessions.latest ? data.sessions.latest.directory : 'none'
      const directories = sessionsOk && Array.isArray(data.sessions.directories) && data.sessions.directories.length
        ? '<ul>' + data.sessions.directories.map(function (item) { return '<li><code>' + item + '</code></li>' }).join('') + '</ul>'
        : '<div class="bad">' + (data.sessions && data.sessions.error ? data.sessions.error : 'No restoreable directories found') + '</div>'
      meta.innerHTML = ''
        + '<div class="line"><span class="k">Target</span><code>' + data.target.host + ':' + data.target.port + '</code></div>'
        + '<div class="line"><span class="k">Source</span><code>' + ((data.source && data.source.label) || 'Global CLI service') + '</code></div>'
        + '<div class="line"><span class="k">CLI Version</span><code>' + versionText + '</code></div>'
        + '<div class="line"><span class="k">Health</span>' + healthText + '<span class="k">Latency</span><code>' + latencyText + '</code></div>'
        + '<div class="line"><span class="k">Latest Session</span><code>' + latestTitle + '</code></div>'
        + '<div class="line"><span class="k">Latest Directory</span><code>' + latestDir + '</code></div>'
        + '<div class="line"><span class="k">Directories</span></div>'
        + directories
    }
    async function inspect() {
      const t = target()
      status.textContent = 'Inspecting target...'
      const url = '/__oc/meta?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port)
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      renderMeta(data)
      if (data.ready) { status.textContent = 'Target is ready'; return data }
      if (!data.health || !data.health.ok) throw new Error(data.health && data.health.error ? data.health.error : 'Target unreachable')
      if (!data.sessions || !data.sessions.ok) throw new Error(data.sessions && data.sessions.error ? data.sessions.error : 'Session scan failed')
      throw new Error('Target is online but has no restoreable session')
    }
    async function openLatest() {
      try {
        const t = target()
        status.textContent = 'Restoring history...'
        location.href = '/__oc/launch?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port)
      } catch (error) {
        status.textContent = error.message || String(error)
      }
    }
    document.getElementById('open').addEventListener('click', openLatest)
    document.getElementById('check').addEventListener('click', function () { inspect().catch(function (error) { status.textContent = error.message || String(error) }) })
    document.getElementById('clear').addEventListener('click', function () {
      host.value = ''
      port.value = '3000'
      status.textContent = ''
      meta.textContent = 'Enter a target and click Check.'
      fetch('/__oc/clear', { method: 'POST', credentials: 'same-origin' }).catch(function () {})
      host.focus()
    })
    for (const input of [host, port]) input.addEventListener('keydown', function (event) { if (event.key === 'Enter') openLatest() })
  </script>
</body>
</html>`
}

function cleanSearch(input) {
  const next = new URLSearchParams(input)
  next.delete("host")
  next.delete("port")
  const text = next.toString()
  return text ? `?${text}` : ""
}

function proxyRequest(req, res, target, reqUrl) {
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
  }
  delete options.headers.cookie
  delete options.headers["content-length"]
  const upstream = http.request(options, (up) => {
    const headers = { ...up.headers }
    const location = rewriteLocation(headers.location, { headersHost: req.headers.host }, target)
    if (location) headers.location = location
    else delete headers.location
    const wantCookie = reqUrl.searchParams.has("host") || reqUrl.searchParams.has("port")
    if (wantCookie) headers["set-cookie"] = [`${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax`]
    res.writeHead(up.statusCode || 502, headers)
    up.pipe(res)
  })
  upstream.on("error", (err) => {
    if (res.headersSent || res.writableEnded || res.destroyed) return
    json(res, 502, { error: err.message })
  })
  req.on("data", (chunk) => upstream.write(chunk))
  req.on("end", () => upstream.end())
}

function writeUpgradeResponse(socket, response) {
  const lines = [`HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || "Switching Protocols"}`]
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`))
    else if (value !== undefined) lines.push(`${key}: ${value}`)
  }
  lines.push("", "")
  socket.write(lines.join("\r\n"))
}

function proxyUpgrade(req, socket, head, target, reqUrl) {
  const upstream = http.request({
    hostname: target.host,
    port: Number(target.port),
    method: req.method,
    path: `${reqUrl.pathname}${cleanSearch(reqUrl.searchParams)}`,
    headers: { ...req.headers, host: `${target.host}:${target.port}`, connection: "upgrade" },
  })
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    writeUpgradeResponse(socket, upRes)
    if (head && head.length) upSocket.write(head)
    if (upHead && upHead.length) socket.write(upHead)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
  })
  upstream.on("response", () => socket.destroy())
  upstream.on("error", () => socket.destroy())
  upstream.end()
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  if (reqUrl.pathname === "/favicon.ico") {
    res.writeHead(204, { "Cache-Control": "public, max-age=86400" })
    res.end()
    return
  }
  const isLanding = !reqUrl.pathname || reqUrl.pathname === "/" || reqUrl.pathname === "/index.html" || reqUrl.pathname === "/__landing"
  if (isLanding) {
    const target = getTarget(reqUrl, req.headers, { allowEmpty: true, useCookie: false }) || { host: "", port: "3000" }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(landing(target))
    return
  }
  if (reqUrl.pathname === "/__oc/clear") {
    clearTargetCookie(res)
    json(res, 200, { ok: true })
    return
  }
  const target = getTarget(reqUrl, req.headers)
  if (!target) {
    json(res, 400, { error: "Invalid target host or port" })
    return
  }
  const wantCookie = reqUrl.searchParams.has("host") || reqUrl.searchParams.has("port")
  if (reqUrl.pathname === "/__oc/meta") {
    const payload = await inspectCached(target)
    const extra = wantCookie ? { "Set-Cookie": `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax` } : undefined
    json(res, 200, payload, extra)
    return
  }
  if (reqUrl.pathname === "/__oc/launch") {
    const payload = await inspectCached(target)
    if (payload.ready && payload.sessions && payload.sessions.latest) payload.launch = { directory: encodeDir(payload.sessions.latest.directory), sessionID: payload.sessions.latest.id }
    if (wantCookie) setTargetCookie(res, target)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(launchPage(payload))
    return
  }
  if (wantCookie) setTargetCookie(res, target)
  proxyRequest(req, res, target, reqUrl)
})

server.on("upgrade", (req, socket, head) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  const target = getTarget(reqUrl, req.headers)
  if (!target) {
    socket.destroy()
    return
  }
  proxyUpgrade(req, socket, head, target, reqUrl)
})

server.listen(bindPort, bindHost, () => {
  console.log(`OpenCode router listening on http://${bindHost}:${bindPort}`)
})
