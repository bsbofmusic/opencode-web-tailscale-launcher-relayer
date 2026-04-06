const http = require("http")

const bindHost = process.env.OPENCODE_ROUTER_HOST || "127.0.0.1"
const bindPort = Number(process.env.OPENCODE_ROUTER_PORT || "33102")
const targetCookie = "oc_target"
const maxSessions = 80
const maxProjects = 12
const inspectTimeoutMs = 5000
const metaCacheMs = 15000
const snapshotCacheMs = 45000
const warmSessionCount = 4

const states = new Map()

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

function raw(res, code, body, type, extra) {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    ...(extra || {}),
  })
  res.end(body)
}

function text(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "public, max-age=86400",
  })
  res.end(body)
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
    const body = await res.text()
    if (!res.ok) throw new Error(`Upstream returned ${res.status}`)
    return {
      data: body ? JSON.parse(body) : null,
      text: body,
      latencyMs: Date.now() - start,
      headers: Object.fromEntries(res.headers.entries()),
    }
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

function keyFor(target) {
  return `${target.host}:${target.port}`
}

function now() {
  return Date.now()
}

function fresh(at, ttl) {
  return Boolean(at && now() - at < ttl)
}

function cacheKey(directory, sessionID, limit) {
  return `${directory}\n${sessionID}\n${limit}`
}

function createState(target) {
  return {
    target,
    meta: undefined,
    metaAt: 0,
    sessionList: [],
    lists: new Map(),
    messages: new Map(),
    details: new Map(),
    warm: {
      active: false,
      ready: false,
      first: true,
      percent: 0,
      stage: "idle",
      note: "Waiting",
      cachedAt: 0,
      latestSessionID: undefined,
      latestDirectory: undefined,
      error: null,
    },
    promise: undefined,
  }
}

function ensureState(target) {
  const key = keyFor(target)
  const hit = states.get(key)
  if (hit) return hit
  const next = createState(target)
  states.set(key, next)
  return next
}

function setWarm(state, patch) {
  state.warm = { ...state.warm, ...patch }
}

function buildMeta(target, health, list, latencyMs) {
  const root = latest(list)
  return {
    target,
    source: {
      kind: "cli",
      label: "Global CLI service",
    },
    health: {
      ok: true,
      healthy: health?.healthy === true,
      version: health?.version || null,
      latencyMs,
      error: health?.healthy === true ? null : "OpenCode unhealthy",
    },
    sessions: {
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
    },
    ready: Boolean(health?.healthy === true && root?.id && root?.directory),
    cache: {
      source: "router",
      cachedAt: now(),
      warm: true,
    },
  }
}

function buildList(list, directory, limit) {
  return list.filter((item) => item?.directory === directory).slice(0, limit)
}

function rememberList(state, directory, limit) {
  const text = JSON.stringify(buildList(state.sessionList, directory, limit))
  state.lists.set(`${directory}\n${limit}`, {
    body: text,
    type: "application/json",
    at: now(),
  })
}

async function cacheMessages(state, target, directory, sessionID, limit) {
  const path = `/session/${encodeURIComponent(sessionID)}/message?limit=${limit}&directory=${encodeURIComponent(directory)}`
  const data = await fetchJson(target, path)
  state.messages.set(cacheKey(directory, sessionID, limit), {
    body: data.text,
    type: "application/json",
    at: now(),
    sessionID,
    directory,
    limit,
  })
}

async function cacheDetail(state, target, directory, sessionID) {
  const path = `/session/${encodeURIComponent(sessionID)}?directory=${encodeURIComponent(directory)}`
  const data = await fetchJson(target, path)
  state.details.set(`${directory}\n${sessionID}`, {
    body: data.text,
    type: "application/json",
    at: now(),
  })
}

async function warm(state, force) {
  if (state.promise) return state.promise
  if (!force && fresh(state.metaAt, metaCacheMs) && state.meta) return Promise.resolve(state.meta)
  const target = state.target
  const run = (async () => {
    setWarm(state, {
      active: true,
      ready: false,
      percent: 5,
      stage: "connect",
      note: state.meta ? "Refreshing cached state..." : "First read may take longer while the VPS builds a cache.",
      error: null,
    })

    let health
    try {
      health = await fetchJson(target, "/global/health")
    } catch (err) {
      setWarm(state, {
        active: false,
        ready: false,
        percent: 100,
        stage: "error",
        note: classifyError(err, "Health check failed"),
        error: classifyError(err, "Health check failed"),
      })
      throw err
    }

    setWarm(state, {
      percent: 28,
      stage: "index",
      note: "Reading remote session index...",
    })

    let sessions
    try {
      sessions = await fetchJson(target, `/session?limit=${maxSessions}`)
    } catch (err) {
      setWarm(state, {
        active: false,
        ready: false,
        percent: 100,
        stage: "error",
        note: classifyError(err, "Session scan failed"),
        error: classifyError(err, "Session scan failed"),
      })
      throw err
    }

    state.sessionList = Array.isArray(sessions.data) ? sessions.data : []
    state.meta = buildMeta(target, health.data, state.sessionList, health.latencyMs)
    state.metaAt = now()
    for (const dir of uniqueDirectories(state.sessionList)) rememberList(state, dir, 55)

    if (!state.meta.ready) {
      setWarm(state, {
        active: false,
        ready: false,
        percent: 100,
        stage: "done",
        note: state.meta.sessions.error || "No restoreable session found",
        cachedAt: state.metaAt,
      })
      return state.meta
    }

    const latestSession = state.meta.sessions.latest
    const nearby = state.sessionList
      .filter((item) => item?.directory === latestSession.directory)
      .slice(0, warmSessionCount)

    setWarm(state, {
      percent: 55,
      stage: "snapshot",
      note: `Caching ${nearby.length || 1} recent session snapshots...`,
      latestSessionID: latestSession.id,
      latestDirectory: latestSession.directory,
    })

    await cacheDetail(state, target, latestSession.directory, latestSession.id)

    for (let i = 0; i < nearby.length; i++) {
      const item = nearby[i]
      const limit = item.id === latestSession.id ? 80 : 200
      setWarm(state, {
        percent: 55 + Math.round(((i + 1) / Math.max(nearby.length, 1)) * 35),
        stage: "snapshot",
        note: `Caching session ${i + 1}/${Math.max(nearby.length, 1)}...`,
      })
      await cacheMessages(state, target, item.directory, item.id, limit)
    }

    setWarm(state, {
      active: false,
      ready: true,
      first: false,
      percent: 100,
      stage: "ready",
      note: "Cache is ready. Opening the latest session...",
      cachedAt: now(),
      latestSessionID: latestSession.id,
      latestDirectory: latestSession.directory,
      error: null,
    })

    state.meta.cache = {
      source: "router",
      cachedAt: state.warm.cachedAt,
      warm: true,
    }

    return state.meta
  })()
    .finally(() => {
      state.promise = undefined
    })

  state.promise = run
  return run
}

function refresh(state) {
  if (state.promise) return
  if (!state.meta) return
  if (fresh(state.metaAt, metaCacheMs)) return
  void warm(state, true).catch(() => {})
}

function progressPayload(state) {
  const payload = {
    target: state.target,
    ready: state.warm.ready && Boolean(state.meta?.ready),
    warm: state.warm,
    meta: state.meta || null,
  }
  if (payload.ready && state.meta?.sessions?.latest) {
    payload.launch = {
      directory: encodeDir(state.meta.sessions.latest.directory),
      sessionID: state.meta.sessions.latest.id,
    }
  }
  return payload
}

function launchPage(target) {
  const payload = JSON.stringify(target).replace(/</g, "\\u003c")
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
    main { width: min(720px, 100%); border: 1px solid #20314b; border-radius: 22px; padding: 22px; background: rgba(13, 21, 35, .94); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { margin: 0; color: #8fa6c7; }
    .bar { margin-top: 18px; width: 100%; height: 10px; border-radius: 999px; background: #162235; overflow: hidden; border: 1px solid #22324b; }
    .fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2c7dff, #66b3ff); transition: width .2s ease; }
    .line { margin-top: 14px; color: #d3e3ff; }
    .hint { margin-top: 10px; color: #8fa6c7; font-size: 13px; }
    ul { margin: 16px 0 0; padding: 0 0 0 18px; color: #c7d8f4; }
    li { margin-top: 6px; }
    code { color: #d3e3ff; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>Launching Remote OpenCode</h1>
    <p>The VPS is warming a cache so future opens do not start cold.</p>
    <div class="bar"><div id="fill" class="fill"></div></div>
    <div id="stage" class="line">Connecting...</div>
    <div id="note" class="hint">Preparing...</div>
    <ul>
      <li>Connect to the remote OpenCode instance</li>
      <li>Read the recent session index</li>
      <li>Cache the latest session snapshot on the VPS</li>
      <li>Open the session and refresh in the background</li>
    </ul>
  </main>
  <script>
    const target = ${payload}
    const fill = document.getElementById('fill')
    const stage = document.getElementById('stage')
    const note = document.getElementById('note')
    const serverKey = 'opencode.global.dat:server'
    const defaultServerKey = 'opencode.settings.dat:defaultServerUrl'
    const snapshotKey = 'opencode.router.dat:snapshot'
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
      sessionStorage.setItem(snapshotKey, JSON.stringify({ cachedAt: Date.now(), source: 'vps', target: target }))
    }
    function label(value) {
      const map = {
        connect: 'Connecting to remote OpenCode...',
        index: 'Reading recent session index...',
        snapshot: 'Caching recent session snapshots on the VPS...',
        ready: 'Cache ready. Opening the latest session...',
        error: 'The VPS could not warm this target.',
        idle: 'Preparing...',
      }
      return map[value] || 'Preparing...'
    }
    async function tick() {
      const url = '/__oc/progress?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port)
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json()
      fill.style.width = Math.max(4, data.warm && data.warm.percent ? data.warm.percent : 4) + '%'
      stage.textContent = label(data.warm && data.warm.stage)
      note.textContent = data.warm && data.warm.note ? data.warm.note : 'Preparing...'
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      if (!data.ready || !data.meta || !data.launch) return false
      seed(data.meta)
      const next = '/' + data.launch.directory + '/session/' + encodeURIComponent(data.launch.sessionID)
        + '?host=' + encodeURIComponent(target.host)
        + '&port=' + encodeURIComponent(target.port)
      location.replace(next)
      return true
    }
    async function loop() {
      for (;;) {
        try {
          const done = await tick()
          if (done) return
        } catch (error) {
          stage.textContent = 'The VPS could not warm this target.'
          note.textContent = error && error.message ? error.message : String(error)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 450))
      }
    }
    loop()
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
      const cacheText = data.cache && data.cache.cachedAt ? new Date(data.cache.cachedAt).toLocaleTimeString() : 'n/a'
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
        + '<div class="line"><span class="k">Cache Built</span><code>' + cacheText + '</code></div>'
        + '<div class="line"><span class="k">Directories</span></div>'
        + directories
    }
    async function inspect() {
      const t = target()
      status.textContent = 'Reading the VPS cache and refreshing metadata...'
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
        status.textContent = 'Warming the VPS cache and preparing the latest session...'
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

function maybeServeCached(req, res, state, reqUrl) {
  if (req.method !== "GET") return false
  const directory = reqUrl.searchParams.get("directory") || state.warm.latestDirectory

  if (reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true" && directory) {
    const limit = Number(reqUrl.searchParams.get("limit") || "55")
    const hit = state.lists.get(`${directory}\n${limit}`) || state.lists.get(`${directory}\n55`)
    if (!hit) return false
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state)
    raw(res, 200, hit.body, hit.type, { "X-OC-Cache": "hit" })
    return true
  }

  const match = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (match && directory && !reqUrl.searchParams.has("cursor")) {
    const sessionID = decodeURIComponent(match[1])
    const limit = Number(reqUrl.searchParams.get("limit") || "0")
    const hit = state.messages.get(cacheKey(directory, sessionID, limit))
    if (!hit) return false
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state)
    raw(res, 200, hit.body, hit.type, { "X-OC-Cache": "hit" })
    return true
  }

  const detail = reqUrl.pathname.match(/^\/session\/([^/]+)$/)
  if (detail && directory) {
    const sessionID = decodeURIComponent(detail[1])
    const hit = state.details.get(`${directory}\n${sessionID}`)
    if (!hit) return false
    if (!fresh(hit.at, snapshotCacheMs)) refresh(state)
    raw(res, 200, hit.body, hit.type, { "X-OC-Cache": "hit" })
    return true
  }

  return false
}

function proxyRequest(req, res, target, reqUrl, state) {
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

    const dir = reqUrl.searchParams.get("directory") || state?.warm?.latestDirectory
    const msg = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
    const limit = Number(reqUrl.searchParams.get("limit") || "0")
    const canStore = req.method === "GET" && dir && !reqUrl.searchParams.has("cursor") && ((msg && (limit === 80 || limit === 200)) || reqUrl.pathname === "/session" || /^\/session\/[^/]+$/.test(reqUrl.pathname))

    if (!canStore) {
      res.writeHead(up.statusCode || 502, headers)
      up.pipe(res)
      return
    }

    const chunks = []
    up.on("data", (chunk) => chunks.push(chunk))
    up.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      if (msg) {
        const sessionID = decodeURIComponent(msg[1])
        state.messages.set(cacheKey(dir, sessionID, limit), {
          body,
          type: String(headers["content-type"] || "application/json"),
          at: now(),
          sessionID,
          directory: dir,
          limit,
        })
      }
      if (reqUrl.pathname === "/session" && reqUrl.searchParams.get("roots") === "true") {
        state.lists.set(`${dir}\n${Number(reqUrl.searchParams.get("limit") || "55")}`, {
          body,
          type: String(headers["content-type"] || "application/json"),
          at: now(),
        })
      }
      const detail = reqUrl.pathname.match(/^\/session\/([^/]+)$/)
      if (detail && dir) {
        state.details.set(`${dir}\n${decodeURIComponent(detail[1])}`, {
          body,
          type: String(headers["content-type"] || "application/json"),
          at: now(),
        })
      }
      res.writeHead(up.statusCode || 502, headers)
      res.end(body)
    })
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
  if (reqUrl.pathname === "/site.webmanifest") {
    text(
      res,
      200,
      JSON.stringify({
        name: "OpenCode",
        short_name: "OpenCode",
        display: "standalone",
        start_url: "/",
        background_color: "#08111d",
        theme_color: "#08111d",
        icons: [],
      }),
      "application/manifest+json",
    )
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
  const state = ensureState(target)
  const wantCookie = reqUrl.searchParams.has("host") || reqUrl.searchParams.has("port")

  if (reqUrl.pathname === "/__oc/progress") {
    try {
      void warm(state, false).catch(() => {})
      json(res, 200, progressPayload(state), wantCookie ? { "Set-Cookie": `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax` } : undefined)
    } catch (err) {
      json(res, 502, { error: classifyError(err, "Warm failed") })
    }
    return
  }

  if (reqUrl.pathname === "/__oc/meta") {
    try {
      const meta = state.meta && fresh(state.metaAt, metaCacheMs) ? state.meta : await warm(state, false)
      refresh(state)
      json(res, 200, meta, wantCookie ? { "Set-Cookie": `${targetCookie}=${target.host}:${target.port}; Path=/; Max-Age=2592000; SameSite=Lax` } : undefined)
    } catch (err) {
      json(res, 502, { error: classifyError(err, "Target inspection failed") })
    }
    return
  }

  if (reqUrl.pathname === "/__oc/launch") {
    void warm(state, false).catch(() => {})
    if (wantCookie) setTargetCookie(res, target)
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
    res.end(launchPage(target))
    return
  }

  if (wantCookie) setTargetCookie(res, target)
  if (maybeServeCached(req, res, state, reqUrl)) return
  proxyRequest(req, res, target, reqUrl, state)
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
