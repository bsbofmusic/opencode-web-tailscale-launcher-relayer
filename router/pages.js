"use strict"

const { escapeHtml, validClient } = require("./util")

function sessionTimeoutPage(target, reqUrl, timeoutMs) {
  const sessionPath = escapeHtml(reqUrl.pathname)
  const host = escapeHtml(target.host)
  const port = escapeHtml(target.port)
  const client = reqUrl.searchParams.get("client")
  const launchParams = new URLSearchParams({ host: target.host, port: target.port })
  if (validClient(client)) launchParams.set("client", client)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Session Timeout</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #13233e 0, #08111d 46%); color: #eef4ff; font: 15px/1.5 Inter, "Segoe UI", sans-serif; }
    main { width: min(760px, 100%); border: 1px solid #20314b; border-radius: 22px; padding: 22px; background: rgba(13, 21, 35, .94); box-shadow: 0 20px 60px rgba(0,0,0,.35); }
    h1 { margin: 0 0 10px; font-size: 28px; }
    p { margin: 10px 0 0; color: #8fa6c7; }
    .actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    a { display: inline-flex; align-items: center; justify-content: center; padding: 11px 15px; border-radius: 12px; border: 1px solid #334155; background: #101b2b; color: #eef4ff; text-decoration: none; }
    .primary { background: linear-gradient(180deg, #3d8cff, #2c7dff); border-color: #3279e7; }
    code { color: #d3e3ff; word-break: break-all; }
  </style>
</head>
<body>
  <main>
    <h1>OpenCode session page is taking too long</h1>
    <p>The remote OpenCode HTML route did not return a page within ${timeoutMs} ms. Cached session APIs may still be alive, but the application shell is not loading cleanly right now.</p>
    <p><code>${sessionPath}</code></p>
    <p>Target: <code>${host}:${port}</code></p>
    <div class="actions">
      <a class="primary" href="${escapeHtml(reqUrl.pathname + reqUrl.search)}">Retry this session</a>
      <a href="/__oc/launch?${launchParams.toString()}">Retry via launch</a>
      <a href="/?${launchParams.toString()}">Back to router</a>
    </div>
  </main>
</body>
</html>`
}

function landingPage(target) {
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
    const clientKey = 'opencode.router.dat:client'
    const search = new URLSearchParams(location.search)
    let stream = null
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
    function validClient(value) {
      return /^[a-zA-Z0-9_-]{8,64}$/.test(String(value || ''))
    }
    function client() {
      const hit = sessionStorage.getItem(clientKey)
      if (validClient(hit)) return hit
      const next = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
      sessionStorage.setItem(clientKey, next)
      return next
    }
    function target() {
      const ip = host.value.trim()
      const p = cleanPort(port.value.trim() || '3000')
      if (!validIp(ip)) throw new Error('Invalid Tailscale IPv4')
      return { host: ip, port: p }
    }
    function renderMeta(data) {
      function esc(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
      }
      const healthOk = data.health && data.health.ok
      const sessionsOk = data.sessions && data.sessions.ok
      const healthText = healthOk ? '<span class="ok">healthy</span>' : '<span class="bad">' + esc(data.health && data.health.error ? data.health.error : 'unreachable') + '</span>'
      const versionText = esc(data.health && data.health.version ? data.health.version : 'unknown')
      const latencyText = data.health && typeof data.health.latencyMs === 'number' ? data.health.latencyMs + ' ms' : 'n/a'
      const latestTitle = esc(sessionsOk && data.sessions.latest ? (data.sessions.latest.title || data.sessions.latest.id || 'none') : 'none')
      const latestDir = esc(sessionsOk && data.sessions.latest ? data.sessions.latest.directory : 'none')
      const cacheText = data.cache && data.cache.cachedAt ? new Date(data.cache.cachedAt).toLocaleTimeString() : 'n/a'
      const directories = sessionsOk && Array.isArray(data.sessions.directories) && data.sessions.directories.length
        ? '<ul>' + data.sessions.directories.map(function (item) { return '<li><code>' + esc(item) + '</code></li>' }).join('') + '</ul>'
        : '<div class="bad">' + esc(data.sessions && data.sessions.error ? data.sessions.error : 'No restoreable directories found') + '</div>'
      meta.innerHTML = ''
        + '<div class="line"><span class="k">Target</span><code>' + esc(data.target.host) + ':' + esc(data.target.port) + '</code></div>'
        + '<div class="line"><span class="k">Type</span><code>' + esc(data.targetType || 'attach-only') + '</code></div>'
        + '<div class="line"><span class="k">Admission</span><code>' + esc(data.admission || 'probe') + '</code></div>'
        + '<div class="line"><span class="k">Source</span><code>' + esc((data.source && data.source.label) || 'Global CLI service') + '</code></div>'
        + '<div class="line"><span class="k">CLI Version</span><code>' + versionText + '</code></div>'
        + '<div class="line"><span class="k">Health</span>' + healthText + '<span class="k">Latency</span><code>' + latencyText + '</code></div>'
        + '<div class="line"><span class="k">Latest Session</span><code>' + latestTitle + '</code></div>'
        + '<div class="line"><span class="k">Latest Directory</span><code>' + latestDir + '</code></div>'
        + '<div class="line"><span class="k">Cache Built</span><code>' + cacheText + '</code></div>'
        + '<div class="line"><span class="k">Directories</span></div>'
        + directories
    }
    function bindEvents(t) {
      if (stream) stream.close()
      const url = '/__oc/events?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      stream = new EventSource(url)
      stream.addEventListener('message-appended', function (event) {
        try {
          const payload = JSON.parse(event.data || '{}')
          status.textContent = 'Remote activity detected in ' + (payload.sessionID || 'the current target')
        } catch {}
      })
      stream.addEventListener('target-health-changed', function (event) {
        try {
          const payload = JSON.parse(event.data || '{}')
          status.textContent = payload.healthy ? 'Target is back online' : 'Target is offline. Serving cached data when possible.'
        } catch {}
      })
      stream.addEventListener('session-list-updated', function () {
        status.textContent = 'Recent sessions changed. Refreshing metadata...'
        inspect().catch(function () {})
      })
    }
    async function inspect() {
      const t = target()
      status.textContent = 'Reading the VPS cache and refreshing metadata...'
      const url = '/__oc/meta?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      renderMeta(data)
      bindEvents(t)
      if (data.ready) { status.textContent = 'Target is ready'; return data }
      if (!data.health || !data.health.ok) throw new Error(data.health && data.health.error ? data.health.error : 'Target unreachable')
      if (!data.sessions || !data.sessions.ok) throw new Error(data.sessions && data.sessions.error ? data.sessions.error : 'Session scan failed')
      throw new Error('Target is online but has no restoreable session')
    }
    async function openLatest() {
      try {
        const t = target()
        status.textContent = 'Warming the VPS cache and preparing the latest session...'
        location.href = '/__oc/launch?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      } catch (error) {
        status.textContent = error.message || String(error)
      }
    }
    document.getElementById('open').addEventListener('click', openLatest)
    document.getElementById('check').addEventListener('click', function () { inspect().catch(function (error) { status.textContent = error.message || String(error) }) })
    document.getElementById('clear').addEventListener('click', function () {
      if (stream) stream.close()
      host.value = ''
      port.value = '3000'
      status.textContent = ''
      meta.textContent = 'Enter a target and click Check.'
      sessionStorage.removeItem(clientKey)
      fetch('/__oc/clear', { method: 'POST', credentials: 'same-origin' }).catch(function () {})
      host.focus()
    })
    for (const input of [host, port]) input.addEventListener('keydown', function (event) { if (event.key === 'Enter') openLatest() })
    if (search.get('host')) {
      if (search.get('autogo') === '0') {
        inspect().catch(function (error) { status.textContent = error.message || String(error) })
      } else {
        openLatest()
      }
    }
  </script>
</body>
</html>`
}

function serialize(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

function launchPage(target, clientID, initial) {
  const payload = serialize({ ...target, client: clientID })
  const initialPayload = serialize(initial || null)
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
  <script id="oc-launch-target" type="application/json">${payload}</script>
  <script id="oc-launch-initial" type="application/json">${initialPayload}</script>
  <main>
    <h1>Launching Remote OpenCode</h1>
    <p>The VPS is warming a cache so future opens do not start cold.</p>
    <div class="bar"><div id="fill" class="fill"></div></div>
    <div id="stage" class="line">Connecting...</div>
    <div id="note" class="hint">Preparing...</div>
    <button id="fallback" type="button" hidden>Open cached session now</button>
    <ul>
      <li>Connect to the remote OpenCode instance</li>
      <li>Read the recent session index</li>
      <li>Cache the latest session snapshot on the VPS</li>
      <li>Open the session and refresh in the background</li>
    </ul>
  </main>
  <script>
    const target = JSON.parse(document.getElementById('oc-launch-target').textContent)
    const fill = document.getElementById('fill')
    const stage = document.getElementById('stage')
    const note = document.getElementById('note')
    const serverKey = 'opencode.global.dat:server'
    const globalProjectKey = 'opencode.global.dat:globalSync.project'
    const layoutKey = 'opencode.global.dat:layout.page'
    const defaultServerKey = 'opencode.settings.dat:defaultServerUrl'
    const snapshotKey = 'opencode.router.dat:snapshot'
    const clientKey = 'opencode.router.dat:client'
    const origin = location.origin
    const fallback = document.getElementById('fallback')
    let polls = 0
    let cachedLaunch = null
    let retryAfter = 450
    let usedInitial = false
    const initial = JSON.parse(document.getElementById('oc-launch-initial').textContent)
    const shownAt = Date.now()
    function read(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') } catch { return {} } }
    function write(key, value) { localStorage.setItem(key, JSON.stringify(value)) }
    sessionStorage.setItem(clientKey, target.client)
    function encodeDir(value) {
      return btoa(unescape(encodeURIComponent(String(value || '')))).split('+').join('-').split('/').join('_').replace(/=+$/g, '')
    }
    async function fetchJson(url, timeoutMs) {
      const ctrl = new AbortController()
      const timer = setTimeout(function () { ctrl.abort() }, timeoutMs || 4000)
      try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal })
        const data = await res.json()
        return { res, data }
      } finally {
        clearTimeout(timer)
      }
    }
    function nextUrl(launch) {
      return '/' + launch.directory + '/session/' + encodeURIComponent(launch.sessionID)
        + '?host=' + encodeURIComponent(target.host)
        + '&port=' + encodeURIComponent(target.port)
        + '&client=' + encodeURIComponent(target.client)
    }
    function reveal(launch) {
      if (!launch) return
      cachedLaunch = launch
      fallback.hidden = false
    }
    function go(launch) {
      reveal(launch)
      location.replace(nextUrl(launch))
    }
    fallback.addEventListener('click', function () {
      if (!cachedLaunch) return
      location.replace(nextUrl(cachedLaunch))
    })
    function serverKeys() {
      const keys = [origin]
      if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') keys.unshift('local')
      return Array.from(new Set(keys))
    }
    function seed(meta) {
      sessionStorage.setItem(clientKey, target.client)
      sessionStorage.setItem(snapshotKey, JSON.stringify({ cachedAt: Date.now(), source: 'vps', target: target, workspaceRoots: (meta.projects && meta.projects.roots) || [] }))
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
    function explain(data) {
      if (data.admission === 'launcher-managed-unavailable') return 'Launcher-managed target is reachable, but OpenCode is not ready there yet.'
      if (data.admission === 'attach-only-unavailable') return 'Attach-only target is not currently serving OpenCode web.'
      if (data.admission === 'no-session') return 'Target is online, but there is no restoreable historical session yet.'
      if (data.failureReason) return data.failureReason
      return data.warm && data.warm.note ? data.warm.note : 'Preparing...'
    }
    stage.textContent = 'Connecting to remote OpenCode...'
    note.textContent = 'Reading the VPS launch state...'
    async function immediateLaunch(data) {
      reveal(data.launch)
      if (data.meta) seed(data.meta)
      stage.textContent = 'Ready. Opening the session...'
      note.textContent = data.resumeSafeMode ? 'Recovery-safe mode is on. The VPS will enter gently.' : 'The VPS has prepared the session. Entering now...'
      const minVisible = 180
      const delay = Math.max(0, minVisible - (Date.now() - shownAt))
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      go(data.launch)
    }
    async function tick() {
      let res, data
      if (!usedInitial && initial) {
        usedInitial = true
        res = { ok: true }
        data = initial
      } else {
        const url = '/__oc/progress?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port)
          + '&client=' + encodeURIComponent(target.client)
        const result = await fetchJson(url, 4000)
        res = result.res
        data = result.data
      }
      polls += 1
      retryAfter = Math.max(450, Number(data.retryAfterMs || 450))
      fill.style.width = Math.max(4, data.warm && data.warm.percent ? data.warm.percent : 4) + '%'
      stage.textContent = label(data.warm && data.warm.stage)
      note.textContent = explain(data)
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      if (data.launchReady && data.launch) {
        reveal(data.launch)
        if (data.meta) seed(data.meta)
        stage.textContent = 'Ready. Opening the session...'
        note.textContent = data.resumeSafeMode ? 'Recovery-safe mode is on. The VPS will enter gently.' : 'The VPS has prepared the session. Entering now...'
        const minVisible = 180
        const delay = Math.max(0, minVisible - (Date.now() - shownAt))
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        go(data.launch)
        return true
      }
      if (polls % 12 === 0) {
        const metaResult = await fetchJson('/__oc/meta?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port) + '&client=' + encodeURIComponent(target.client), 4000)
        const metaRes = metaResult.res
        const meta = metaResult.data
        if (metaRes.ok && meta && meta.ready && meta.sessions && meta.sessions.latest) {
          seed(meta)
          go({ directory: encodeDir(meta.sessions.latest.directory), sessionID: meta.sessions.latest.id })
          return true
        }
      }
      return false
    }
    async function loop() {
      if (initial && initial.launchReady && initial.launch) {
        await immediateLaunch(initial)
        return
      }
      for (;;) {
        try {
          const done = await tick()
          if (done) return
        } catch (error) {
          stage.textContent = 'The VPS could not warm this target.'
          note.textContent = error && error.message ? error.message : String(error)
          if (cachedLaunch) {
            fallback.hidden = false
            note.textContent += ' You can open the cached session now.'
            await new Promise((resolve) => setTimeout(resolve, 1500))
            location.replace(nextUrl(cachedLaunch))
            return
          }
        }
        await new Promise((resolve) => setTimeout(resolve, retryAfter))
      }
    }
    loop()
  </script>
</body>
</html>`
}

function sessionSyncRuntime() {
  return `<script id="oc-tailnet-sync-runtime">;(() => {
    if (window.__ocTailnetSync) return
    const q = new URLSearchParams(location.search)
    const host = q.get('host')
    const port = q.get('port')
    const client = q.get('client')
    if (!host || !port || !client) {
      window.__ocTailnetSync = { mode: 'missing-target' }
      return
    }
    const dirToken = location.pathname.split('/')[1] || ''
    const sessionID = decodeURIComponent(location.pathname.split('/')[3] || '')
    const keyBase = 'oc-tailnet-sync:' + encodeURIComponent(dirToken || 'global') + ':' + encodeURIComponent(sessionID || 'none')
    const key = keyBase + ':last-action'
    const minGap = 2000
    const msgKey = keyBase + ':last-head'
    const startedAt = Date.now()
    const base = '?host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port) + '&client=' + encodeURIComponent(client)
    const withBase = (path) => path + (path.includes('?') ? '&' : '?') + 'host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port) + '&client=' + encodeURIComponent(client)
    const decode = (input) => {
      try {
        const text = input.replace(/-/g, '+').replace(/_/g, '/')
        const pad = text.length % 4 ? '='.repeat(4 - (text.length % 4)) : ''
        return decodeURIComponent(escape(atob(text + pad)))
      } catch {
        return ''
      }
    }
    const directory = decode(dirToken)
    const decodeDir = decode
    const nextUrl = (launch) => '/' + launch.directory + '/session/' + encodeURIComponent(launch.sessionID) + '?host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port) + '&client=' + encodeURIComponent(launch.client || client)
    const sameLaunch = (launch) => nextUrl(launch) === location.pathname + location.search
    // Never let sync recovery jump the browser into a different workspace.
    const workspaceMismatch = (launch) => {
      const currentDir = location.pathname.split('/')[1] || ''
      const launchDir = launch?.directory || ''
      try {
        return decodeDir(currentDir) !== decodeDir(launchDir)
      } catch {
        return false
      }
    }
    const ready = () => document.visibilityState === 'visible' && document.hasFocus()
    const recent = (action) => {
      try {
        const last = JSON.parse(sessionStorage.getItem(key) || '{}')
        return last.action === action && Date.now() - Number(last.at || 0) < minGap
      } catch {
        return false
      }
    }
    const mark = (action) => sessionStorage.setItem(key, JSON.stringify({ action, at: Date.now() }))
    const head = () => {
      try {
        return JSON.parse(sessionStorage.getItem(msgKey) || 'null')
      } catch {
        return null
      }
    }
    const setHead = (value) => sessionStorage.setItem(msgKey, JSON.stringify(value))
    const fetchJson = async (path) => {
      const res = await fetch(withBase(path), { credentials: 'same-origin', cache: 'no-store' })
      return await res.json()
    }
    const withView = (path) => {
      if (!directory || !sessionID) return path
      return path + (path.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent(directory) + '&sessionID=' + encodeURIComponent(sessionID)
    }
    const checkHead = async () => {
      if (!directory || !sessionID) return
      const res = await fetch(withBase('/session/' + encodeURIComponent(sessionID) + '/message?limit=80&directory=' + encodeURIComponent(directory)), { credentials: 'same-origin', cache: 'no-store' })
      if (!res.ok) return
      const rows = await res.json()
      if (!Array.isArray(rows)) return
      const tail = rows.length ? rows[rows.length - 1] : null
      const next = { count: rows.length, tailID: tail?.info?.id || tail?.id || null }
      const prev = head()
      setHead(next)
      if (!prev) return
      if (Date.now() - startedAt < 10000) return
      if (prev.count === next.count && prev.tailID === next.tailID) return
      if (window.__ocTailnetSync?.state === 'protected' || window.__ocTailnetSync?.lastAction === 'defer') return
      if (recent('soft-refresh') || recent('re-enter')) return
      mark('soft-refresh')
      location.replace(location.pathname + location.search)
    }
    const apply = async () => {
      const data = await fetchJson(withView('/__oc/progress'))
      window.__ocTailnetSync.state = data.syncState || 'live'
      window.__ocTailnetSync.lastAction = data.lastAction || 'noop'
      window.__ocTailnetSync.staleReason = data.staleReason || null
      if (!ready()) return
      if (data.lastAction === 'soft-refresh' && data.syncState === 'stale' && !recent('soft-refresh') && (!data.launch || !workspaceMismatch(data.launch))) {
        mark('soft-refresh')
        location.replace(location.pathname + location.search)
        return
      }
      if (data.lastAction === 're-enter' && data.launch && !sameLaunch(data.launch) && !recent('re-enter') && !workspaceMismatch(data.launch)) {
        mark('re-enter')
        location.replace(nextUrl(data.launch))
      }
    }
    let lastHeadCheck = 0
    const pulse = (withHead = false) => {
      void apply()
      if (!withHead) return
      const nowTs = Date.now()
      if (nowTs - lastHeadCheck < 12000) return
      lastHeadCheck = nowTs
      void checkHead()
    }
     window.__ocTailnetSync = { mode: 'active', state: 'live', lastAction: 'noop', staleReason: null }
     const stream = new EventSource('/__oc/events' + base)
     stream.addEventListener('sync-stale', () => pulse(true))
     stream.addEventListener('message-appended', () => pulse(true))
     stream.addEventListener('target-health-changed', () => pulse(false))
     stream.onerror = () => pulse(true)
     document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pulse(true) })
     window.addEventListener('focus', () => pulse(true))
     setInterval(() => pulse(true), 15000)
     void checkHead()
     void apply()
     window.__ocTailnetSyncUI = {
       shouldShow: () => {
         const state = window.__ocTailnetSync?.state || 'live'
         return state !== 'live'
       },
       visibility: () => {
         const state = window.__ocTailnetSync?.state || 'live'
         if (state === 'live') return 'hidden'
         if (state === 'stale' || state === 'protected' || state === 'offline' || state === 'error') return 'visible'
         return 'hidden'
       },
     }
  })();</script>`
}

module.exports = {
  sessionTimeoutPage,
  landingPage,
  launchPage,
  sessionSyncRuntime,
}
