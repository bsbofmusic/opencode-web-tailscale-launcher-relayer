"use strict"

const { escapeHtml, validClient, decodeDir } = require("./util")

function sessionTimeoutPage(target, reqUrl, timeoutMs) {
  const sessionPath = escapeHtml(reqUrl.pathname)
  const host = escapeHtml(target.host)
  const port = escapeHtml(target.port)
  const client = reqUrl.searchParams.get("client")
  const launchParams = new URLSearchParams({ host: target.host, port: target.port })
  const parts = String(reqUrl.pathname || "").split("/")
  const dirToken = parts[1] || ""
  const sessionID = decodeURIComponent(parts[3] || "")
  const directory = decodeDir(dirToken)
  if (validClient(client)) launchParams.set("client", client)
  if (directory && sessionID) {
    launchParams.set("directory", directory)
    launchParams.set("sessionID", sessionID)
  }
  const selectionParams = new URLSearchParams({ host: target.host, port: target.port, autogo: "0" })
  if (directory) selectionParams.set("directory", directory)
  if (sessionID) selectionParams.set("sessionID", sessionID)
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
      <a href="/__oc/launch?${escapeHtml(launchParams.toString())}">Retry selected session via launch</a>
      <a href="/?${escapeHtml(selectionParams.toString())}">Back to selection</a>
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
    .subactions { margin-top: 10px; }
    button { display: inline-flex; align-items: center; justify-content: center; padding: 11px 15px; border-radius: 12px; border: 1px solid #334155; background: #101b2b; color: #eef4ff; cursor: pointer; font: inherit; }
    button[disabled] { opacity: .55; cursor: not-allowed; }
    .primary { background: linear-gradient(180deg, #3d8cff, #2c7dff); border-color: #3279e7; }
    .link-button { padding: 0; border: 0; background: transparent; color: #8fa6c7; text-decoration: underline; border-radius: 0; }
    .status { margin-top: 14px; color: #8fa6c7; min-height: 20px; }
    .meta { margin-top: 14px; padding: 14px; border: 1px solid #20314b; border-radius: 14px; background: rgba(7, 12, 22, .92); display: grid; gap: 10px; }
    .line { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .k { color: #8fa6c7; min-width: 108px; }
    .ok { color: #79e29b; }
    .bad { color: #f1bc65; }
    .workspace-list { display: flex; gap: 8px; flex-wrap: wrap; }
    .workspace-chip { text-align: left; border-radius: 999px; padding: 8px 12px; background: #0f172a; }
    .workspace-chip.selected { background: linear-gradient(180deg, #3d8cff, #2c7dff); border-color: #3279e7; }
    .session-list { display: grid; gap: 8px; }
    .session-item { display: grid; gap: 3px; width: 100%; text-align: left; border-radius: 14px; padding: 12px; background: #0f172a; }
    .session-item.selected { background: linear-gradient(180deg, #233b66, #1b4da0); border-color: #3279e7; }
    .session-item small { color: #8fa6c7; }
    .subtle { color: #8fa6c7; font-size: 13px; }
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
      <button id="open" class="primary" type="button">Open OpenCode Web</button>
      <button id="check" type="button">Check</button>
      <button id="open-selected" type="button" hidden disabled>Open Selected Session</button>
      <button id="clear" type="button" hidden>Clear</button>
    </div>
    <div id="status" class="status"></div>
    <div class="subactions"><button id="advanced-toggle" class="link-button" type="button" hidden>Recover specific session</button></div>
    <div id="meta" class="meta">Enter a target and click Check.</div>
  </main>
  <script>
    const host = document.getElementById('host')
    const port = document.getElementById('port')
    const open = document.getElementById('open')
    const openSelectedButton = document.getElementById('open-selected')
    const advancedToggle = document.getElementById('advanced-toggle')
    const status = document.getElementById('status')
    const meta = document.getElementById('meta')
    const clientKey = 'opencode.router.dat:client'
    const targetKey = 'opencode.router.dat:last-target'
    const search = new URLSearchParams(location.search)
    let stream = null
    let currentMeta = null
    let showAdvanced = Boolean(search.get('directory') || search.get('sessionID') || search.get('advanced') === '1')
    let selectedWorkspace = ''
    let selectedSessionID = ''
    let pendingWorkspace = search.get('directory') || ''
    let pendingSessionID = search.get('sessionID') || ''
    const workspaceSessionLists = new Map()
    const workspaceSessionErrors = new Map()
    let workspaceSessionLoading = ''
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
    function readTarget() {
      try {
        return JSON.parse(localStorage.getItem(targetKey) || 'null')
      } catch {
        return null
      }
    }
    function writeTarget(value) {
      try {
        localStorage.setItem(targetKey, JSON.stringify(value))
      } catch {}
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
    function workspaceRoots(data) {
      const roots = []
      const seen = new Set()
      const add = function (value) {
        const root = String(value || '')
        if (!root || seen.has(root)) return
        seen.add(root)
        roots.push(root)
      }
      const projectRoots = Array.isArray(data && data.projects && data.projects.roots) ? data.projects.roots : []
      const sessionRoots = Array.isArray(data && data.sessions && data.sessions.directories) ? data.sessions.directories : []
      projectRoots.forEach(add)
      sessionRoots.forEach(add)
      return roots
    }
    function selectedSession() {
      const rows = workspaceSessionLists.get(selectedWorkspace) || []
      return rows.find(function (item) { return item && item.id === selectedSessionID }) || null
    }
    function updateOpenState() {
      open.disabled = !validIp(host.value.trim())
      const session = selectedSession()
      openSelectedButton.disabled = !(selectedWorkspace && session && session.directory === selectedWorkspace)
      openSelectedButton.hidden = !showAdvanced
      openSelectedButton.style.display = showAdvanced ? '' : 'none'
      advancedToggle.textContent = showAdvanced ? 'Hide restore options' : 'Recover specific session'
      advancedToggle.hidden = !showAdvanced
    }
    function hasAdvancedData(data) {
      return Boolean(
        data && (
          (Array.isArray(data.projects && data.projects.roots) && data.projects.roots.length) ||
          (Array.isArray(data.sessions && data.sessions.directories) && data.sessions.directories.length)
        )
      )
    }
    async function loadWorkspaceSessions(directory) {
      if (!directory) return []
      if (workspaceSessionLists.has(directory)) return workspaceSessionLists.get(directory) || []
      const currentTarget = target()
      const url = '/session?directory=' + encodeURIComponent(directory)
        + '&roots=true&limit=55'
        + '&host=' + encodeURIComponent(currentTarget.host)
        + '&port=' + encodeURIComponent(currentTarget.port)
        + '&client=' + encodeURIComponent(client())
      workspaceSessionLoading = directory
      workspaceSessionErrors.delete(directory)
      renderMeta(currentMeta)
      try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' })
        const rows = await res.json()
        if (!res.ok) throw new Error(rows && rows.error ? rows.error : ('Request failed: ' + res.status))
        const list = Array.isArray(rows) ? rows : []
        workspaceSessionLists.set(directory, list)
        if (directory === pendingWorkspace && pendingSessionID) {
          const match = list.find(function (item) { return item && item.id === pendingSessionID })
          if (match) selectedSessionID = pendingSessionID
          pendingSessionID = ''
        }
        return list
      } catch (error) {
        workspaceSessionErrors.set(directory, error && error.message ? error.message : String(error))
        workspaceSessionLists.set(directory, [])
        return []
      } finally {
        if (workspaceSessionLoading === directory) workspaceSessionLoading = ''
        renderMeta(currentMeta)
      }
    }
    function renderMeta(data) {
      currentMeta = data || null
      function esc(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
      }
      const healthOk = data.health && data.health.ok
      const sessionsOk = data.sessions && data.sessions.ok
      const roots = workspaceRoots(data)
      if (pendingWorkspace && roots.includes(pendingWorkspace) && !selectedWorkspace) selectedWorkspace = pendingWorkspace
      if (!roots.includes(selectedWorkspace)) selectedWorkspace = ''
      if (!selectedWorkspace) selectedSessionID = ''
      const session = selectedSession()
      const healthText = healthOk ? '<span class="ok">healthy</span>' : '<span class="bad">' + esc(data.health && data.health.error ? data.health.error : 'unreachable') + '</span>'
      const versionText = esc(data.health && data.health.version ? data.health.version : 'unknown')
      const latencyText = data.health && typeof data.health.latencyMs === 'number' ? data.health.latencyMs + ' ms' : 'n/a'
      const latestTitle = esc(sessionsOk && data.sessions.latest ? (data.sessions.latest.title || data.sessions.latest.id || 'none') : 'none')
      const latestDir = esc(sessionsOk && data.sessions.latest ? data.sessions.latest.directory : 'none')
      const cacheText = data.cache && data.cache.cachedAt ? new Date(data.cache.cachedAt).toLocaleTimeString() : 'n/a'
      const selectedText = selectedWorkspace
        ? '<code>' + esc(selectedWorkspace) + '</code>'
        : '<span class="bad">Choose a workspace below.</span>'
      const selectedSessionText = session
        ? '<code>' + esc(session.title || session.id) + '</code>'
        : '<span class="bad">Choose a session below.</span>'
      const directories = roots.length
        ? '<div class="workspace-list">' + roots.map(function (item) {
          const selected = item === selectedWorkspace
          return '<button class="workspace-chip' + (selected ? ' selected' : '') + '" type="button" data-workspace="' + esc(item) + '" aria-pressed="' + (selected ? 'true' : 'false') + '">' + esc(item) + '</button>'
        }).join('') + '</div>'
        : '<div class="bad">' + esc(data.sessions && data.sessions.error ? data.sessions.error : 'No restoreable directories found') + '</div>'
      const rows = workspaceSessionLists.get(selectedWorkspace) || []
      const sessionError = workspaceSessionErrors.get(selectedWorkspace) || ''
      const sessionList = !selectedWorkspace
        ? '<div class="bad">Select a workspace first.</div>'
        : workspaceSessionLoading === selectedWorkspace
          ? '<div>Loading sessions for <code>' + esc(selectedWorkspace) + '</code>...</div>'
          : sessionError
            ? '<div class="bad">' + esc(sessionError) + '</div>'
            : rows.length
              ? '<div class="session-list">' + rows.map(function (item) {
                const selected = item && item.id === selectedSessionID
                const title = esc(item && (item.title || item.id) || 'unknown')
                const sid = esc(item && item.id || '')
                const updated = item && item.time && (item.time.updated || item.time.created)
                return '<button class="session-item' + (selected ? ' selected' : '') + '" type="button" data-session-id="' + sid + '" aria-pressed="' + (selected ? 'true' : 'false') + '"><strong>' + title + '</strong><small>' + sid + (updated ? (' · updated ' + esc(updated)) : '') + '</small></button>'
              }).join('') + '</div>'
              : '<div class="bad">No sessions found for <code>' + esc(selectedWorkspace) + '</code>.</div>'
      const basics = ''
        + '<div class="line"><span class="k">Target</span><code>' + esc(data.target.host) + ':' + esc(data.target.port) + '</code></div>'
        + '<div class="line"><span class="k">Health</span>' + healthText + '<span class="k">Latency</span><code>' + latencyText + '</code></div>'
        + '<div class="line"><span class="k">CLI Version</span><code>' + versionText + '</code></div>'
        + (healthOk ? '<div class="line"><span class="k">Open</span><span class="subtle">Target looks reachable. You can open OpenCode Web directly.</span></div>' : '')
      const advanced = ''
        + '<div class="line"><span class="k">Selected Workspace</span>' + selectedText + '</div>'
        + '<div class="line"><span class="k">Workspaces</span></div>'
        + directories
        + '<div class="line"><span class="k">Selected Session</span>' + selectedSessionText + '</div>'
        + '<div class="line"><span class="k">Sessions</span></div>'
        + sessionList
      meta.innerHTML = ''
        + basics
        + (showAdvanced
          ? ('<div class="line"><span class="k">Restore</span><span class="subtle">Advanced restore mode. Use this only when you need a specific historical session.</span></div>' + advanced)
          : '')
      updateOpenState()
      if (showAdvanced && selectedWorkspace && !workspaceSessionLists.has(selectedWorkspace) && workspaceSessionLoading !== selectedWorkspace) {
        void loadWorkspaceSessions(selectedWorkspace)
      }
    }
    meta.addEventListener('click', function (event) {
      const button = event.target && event.target.closest ? event.target.closest('[data-workspace]') : null
      const sessionButton = event.target && event.target.closest ? event.target.closest('[data-session-id]') : null
      if (button && currentMeta) {
        const nextWorkspace = button.getAttribute('data-workspace') || ''
        const changed = nextWorkspace !== selectedWorkspace
        selectedWorkspace = nextWorkspace
        if (changed) selectedSessionID = ''
        renderMeta(currentMeta)
        status.textContent = selectedWorkspace ? ('Workspace selected: ' + selectedWorkspace) : 'Target is ready'
        if (showAdvanced && changed && selectedWorkspace) void loadWorkspaceSessions(selectedWorkspace)
        return
      }
      if (!sessionButton || !currentMeta || !selectedWorkspace) return
      selectedSessionID = sessionButton.getAttribute('data-session-id') || ''
      renderMeta(currentMeta)
      status.textContent = selectedSessionID ? ('Session selected: ' + selectedSessionID) : ('Workspace selected: ' + selectedWorkspace)
    })
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
        if (!showAdvanced) return
        status.textContent = 'Recent sessions changed. Refreshing restore options...'
        inspectAdvanced().catch(function () {})
      })
    }
    async function inspect() {
      const t = target()
      writeTarget(t)
      status.textContent = 'Checking target reachability...'
      const url = '/__oc/check?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      renderMeta(data)
      if (data.health && data.health.ok) { status.textContent = 'Target is reachable. Open Web or load restore options.'; return data }
      throw new Error(data.health && data.health.error ? data.health.error : 'Target unreachable')
    }
    async function inspectAdvanced() {
      const t = target()
      writeTarget(t)
      status.textContent = 'Loading restore options...'
      const url = '/__oc/meta?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      currentMeta = data
      showAdvanced = true
      renderMeta(data)
      bindEvents(t)
      status.textContent = 'Restore options loaded.'
      return data
    }
    async function openWeb() {
      try {
        const t = target()
        writeTarget(t)
        status.textContent = 'Opening OpenCode Web...'
        location.href = '/__oc/launch?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
      } catch (error) {
        status.textContent = error.message || String(error)
      }
    }
    async function openSelected() {
      try {
        const session = selectedSession()
        if (!selectedWorkspace || !session || !session.id || session.directory !== selectedWorkspace) {
          status.textContent = 'Select a workspace and session before opening.'
          updateOpenState()
          return
        }
        const t = target()
        writeTarget(t)
        status.textContent = 'Creating handoff ticket for the selected session...'
        const handoffUrl = '/__oc/handoff?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client())
        const res = await fetch(handoffUrl, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ directory: selectedWorkspace, sessionID: session.id }),
        })
        const payload = await res.json()
        if (!res.ok || !payload || !payload.ticket) throw new Error(payload && payload.error ? payload.error : ('Request failed: ' + res.status))
        status.textContent = 'Handoff ticket created. Opening the selected session...'
        location.href = '/__oc/launch?host=' + encodeURIComponent(t.host) + '&port=' + encodeURIComponent(t.port) + '&client=' + encodeURIComponent(client()) + '&ticket=' + encodeURIComponent(payload.ticket)
      } catch (error) {
        status.textContent = error.message || String(error)
      }
    }
    document.getElementById('open').addEventListener('click', openWeb)
    openSelectedButton.addEventListener('click', openSelected)
    advancedToggle.addEventListener('click', function () {
      if (showAdvanced && hasAdvancedData(currentMeta)) {
        showAdvanced = false
        renderMeta(currentMeta)
        status.textContent = 'Advanced restore options hidden.'
        return
      }
      inspectAdvanced().catch(function (error) { status.textContent = error.message || String(error) })
    })
    document.getElementById('check').addEventListener('click', function () { inspect().catch(function (error) { status.textContent = error.message || String(error) }) })
    const clearButton = document.getElementById('clear')
    if (clearButton) clearButton.addEventListener('click', function () {
      if (stream) stream.close()
      host.value = ''
      port.value = '3000'
      status.textContent = ''
      meta.textContent = 'Enter a target and click Check.'
      currentMeta = null
      showAdvanced = false
      selectedWorkspace = ''
      selectedSessionID = ''
      pendingWorkspace = ''
      pendingSessionID = ''
      workspaceSessionLists.clear()
      workspaceSessionErrors.clear()
      workspaceSessionLoading = ''
      updateOpenState()
      sessionStorage.removeItem(clientKey)
      localStorage.removeItem(targetKey)
      fetch('/__oc/clear', { method: 'POST', credentials: 'same-origin' }).catch(function () {})
      host.focus()
    })
    for (const input of [host, port]) input.addEventListener('input', updateOpenState)
    for (const input of [host, port]) input.addEventListener('keydown', function (event) { if (event.key === 'Enter') void openWeb() })
    const saved = readTarget()
    if (!search.get('host') && !host.value.trim() && saved && validIp(saved.host || '')) {
      host.value = saved.host
      port.value = cleanPort(String(saved.port || '3000'))
    }
    const seeded = host.value.trim()
    const explicitTarget = Boolean(search.get('host'))
    if (pendingWorkspace || pendingSessionID || search.get('advanced') === '1') {
      inspectAdvanced().catch(function (error) { status.textContent = error.message || String(error) })
    } else if (explicitTarget || seeded) {
      status.textContent = 'Target restored. Click Open OpenCode Web or Check when you are ready.'
    }
    updateOpenState()
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

function compatBootstrapRuntime(targetExpr, metaExpr) {
  return `
    const serverKey = 'opencode.global.dat:server'
    const globalProjectKey = 'opencode.global.dat:globalSync.project'
    const defaultServerKey = 'opencode.settings.dat:defaultServerUrl'
    const compatTargetKey = 'opencode.router.dat:compat-target'
    function compatRead(key, fallback) {
      try {
        const hit = localStorage.getItem(key)
        return hit ? JSON.parse(hit) : fallback
      } catch {
        return fallback
      }
    }
    function compatWrite(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
    }
    function compatServerKey() {
      return (location.hostname === '127.0.0.1' || location.hostname === 'localhost') ? 'local' : location.origin
    }
    function compatRoots(meta) {
      const roots = (meta?.projects?.roots || meta?.sessions?.directories || [])
      return roots.filter(function (root) {
        return root && root !== '/' && !(root.length === 1 && root.charCodeAt(0) === 92)
      })
    }
    function compatInventory(meta) {
      const inventory = Array.isArray(meta?.projects?.inventory) ? meta.projects.inventory : []
      return inventory.filter(function (item) {
        return item && item.worktree && item.worktree !== '/' && !(item.worktree.length === 1 && item.worktree.charCodeAt(0) === 92)
      })
    }
    function compatProjectEntry(root, inventoryItem) {
      if (inventoryItem) return { ...inventoryItem }
      return {
        id: 'relay:' + btoa(unescape(encodeURIComponent(String(root || '')))).replace(/=+$/g, ''),
        worktree: root,
        sandboxes: [],
        time: { created: Date.now(), updated: Date.now() },
      }
    }
    function compatSeed(meta) {
      const compatTarget = ${targetExpr}
      if (!meta || !compatTarget?.host || !compatTarget?.port) return
      const roots = compatRoots(meta)
      const inventory = compatInventory(meta)
      const inventoryByRoot = new Map(inventory.map(function (item) { return [String(item.worktree || '').toLowerCase(), item] }))
      const currentKey = compatServerKey()
      const server = compatRead(serverKey, {}) || {}
      const projects = { ...(server.projects || {}) }
      projects[currentKey] = roots.map(function (root) {
        return compatProjectEntry(root, inventoryByRoot.get(String(root).toLowerCase()))
      })
      compatWrite(serverKey, { ...server, projects })
      const globalSync = compatRead(globalProjectKey, {}) || {}
      compatWrite(globalProjectKey, { ...globalSync, value: inventory.filter(function (item) { return roots.includes(item.worktree) }) })
      try { localStorage.setItem(defaultServerKey, location.origin) } catch {}
      compatWrite(compatTargetKey, { host: compatTarget.host, port: compatTarget.port })
    }
    const compatMeta = ${metaExpr}
    compatSeed(compatMeta)
  `
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
    <div class="actions">
      <button id="fallback" type="button" hidden>Retry</button>
      <button id="back" type="button" hidden>Back to selection</button>
    </div>
    <ul>
      <li>Connect to the remote OpenCode instance</li>
      <li>Resolve the explicit handoff decision</li>
      <li>Prepare the selected session for attach</li>
      <li>Open the chosen session once it is ready</li>
    </ul>
  </main>
  <script>
    const target = JSON.parse(document.getElementById('oc-launch-target').textContent)
    const fill = document.getElementById('fill')
    const stage = document.getElementById('stage')
    const note = document.getElementById('note')
    const snapshotKey = 'opencode.router.dat:snapshot'
    const clientKey = 'opencode.router.dat:client'
    const fallback = document.getElementById('fallback')
    const back = document.getElementById('back')
    const initial = JSON.parse(document.getElementById('oc-launch-initial').textContent)
    const ticketID = target.ticket || ''
    const decisionDirectory = target.directory || initial?.directory || ''
    const decisionSessionID = target.sessionID || initial?.sessionID || ''
    let polls = 0
    let retryAfter = 450
    let usedInitial = false
    const shownAt = Date.now()
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
    function go(launch) {
      location.replace(nextUrl(launch))
    }
    fallback.addEventListener('click', function () {
      location.reload()
    })
    back.addEventListener('click', function () {
      let url = '/?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port) + '&autogo=0'
      if (decisionDirectory) url += '&directory=' + encodeURIComponent(decisionDirectory)
      if (decisionSessionID) url += '&sessionID=' + encodeURIComponent(decisionSessionID)
      location.href = url
    })
    function showUnavailable(data) {
      stage.textContent = 'Remote OpenCode is currently unavailable.'
      note.textContent = explain(data)
      fallback.textContent = 'Retry'
      fallback.hidden = false
      back.hidden = false
    }
    function unavailable(data) {
      return Boolean(
        data.offline ||
        data.targetStatus === 'offline' ||
        data.admission === 'launcher-managed-unavailable' ||
        data.admission === 'attach-only-unavailable'
      )
    }
    function seed(meta) {
      const workspaceRoots = ((meta.projects && meta.projects.roots) || []).filter(function (root) {
        return root !== '/' && !(root && root.length === 1 && root.charCodeAt(0) === 92)
      })
      sessionStorage.setItem(clientKey, target.client)
      sessionStorage.setItem(snapshotKey, JSON.stringify({ cachedAt: Date.now(), source: 'vps', target: target, workspaceRoots }))
      ${compatBootstrapRuntime("target", "meta")}
    }
    function label(value) {
      const map = {
        connect: 'Connecting to remote OpenCode...',
        index: 'Reading recent session index...',
        snapshot: 'Caching recent session snapshots on the VPS...',
        selected: 'Using your selected session...',
        bootstrap: 'Preparing the selected session...',
        ready: 'Cache ready. Opening the latest session...',
        failed: 'The selected session could not be prepared.',
        expired: 'This handoff ticket has expired.',
        error: 'The VPS could not warm this target.',
        idle: 'Preparing...',
      }
      return map[value] || 'Preparing...'
    }
    function explain(data) {
      if (ticketID && data && data.error) return data.error
      if (data.admission === 'launcher-managed-unavailable') return 'Launcher-managed target is reachable, but OpenCode is not ready there yet.'
      if (data.admission === 'attach-only-unavailable') return 'Attach-only target is not currently serving OpenCode web.'
      if (data.admission === 'no-session') return 'Target is online, but there is no restoreable historical session yet.'
      if (data.failureReason) return data.failureReason
      return data.warm && data.warm.note ? data.warm.note : 'Preparing...'
    }
    stage.textContent = 'Connecting to remote OpenCode...'
    note.textContent = 'Reading the VPS launch state...'
    async function immediateLaunch(data) {
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
        const url = ticketID
          ? ('/__oc/handoff?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port)
            + '&client=' + encodeURIComponent(target.client)
            + '&ticket=' + encodeURIComponent(ticketID))
          : ('/__oc/progress?host=' + encodeURIComponent(target.host) + '&port=' + encodeURIComponent(target.port)
            + '&client=' + encodeURIComponent(target.client))
        const result = await fetchJson(url, 4000)
        res = result.res
        data = result.data
      }
      polls += 1
      retryAfter = Math.max(450, Number(data.retryAfterMs || 450))
      fill.style.width = Math.max(4, data.warm && data.warm.percent ? data.warm.percent : 4) + '%'
      stage.textContent = label(ticketID ? (data.stage || 'selected') : (data.warm && data.warm.stage))
      note.textContent = explain(data)
      if (ticketID && (data.status === 'failed' || data.status === 'expired')) throw new Error(data.error || ('Request failed: ' + res.status))
      if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status))
      if (unavailable(data)) {
        showUnavailable(data)
        return true
      }
      if (data.launchReady && data.launch) {
        if (data.meta) seed(data.meta)
        stage.textContent = 'Ready. Opening the session...'
        note.textContent = data.resumeSafeMode ? 'Recovery-safe mode is on. The VPS will enter gently.' : 'The VPS has prepared the session. Entering now...'
        const minVisible = 180
        const delay = Math.max(0, minVisible - (Date.now() - shownAt))
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        go(data.launch)
        return true
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
          fallback.textContent = 'Retry'
          fallback.hidden = false
          back.hidden = false
          return
        }
        await new Promise((resolve) => setTimeout(resolve, retryAfter))
      }
    }
    loop()
  </script>
</body>
</html>`
}

function sessionSyncRuntime(bootstrap) {
  const bootstrapPayload = serialize(bootstrap || null)
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
    const startedAt = Date.now()
    const bootstrap = ${bootstrapPayload}
    const base = '?host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port) + '&client=' + encodeURIComponent(client)
    const withBase = (path) => path + (path.includes('?') ? '&' : '?') + 'host=' + encodeURIComponent(host) + '&port=' + encodeURIComponent(port) + '&client=' + encodeURIComponent(client)
    ${compatBootstrapRuntime("bootstrap?.target || { host, port }", "bootstrap?.meta || null")}
    const decode = (input) => {
      try {
        const text = input.replace(/-/g, '+').replace(/_/g, '/')
        const pad = text.length % 4 ? '='.repeat(4 - (text.length % 4)) : ''
        return decodeURIComponent(escape(atob(text + pad)))
      } catch {
        return ''
      }
    }
    const decodeDir = decode
    const currentView = () => {
      try {
        const parts = location.pathname.split('/')
        const dirToken = parts[1] || ''
        if (parts[2] !== 'session') return null
        const routeSessionID = decodeURIComponent(parts[3] || '')
        const directory = decodeDir(dirToken)
        if (!dirToken || !routeSessionID || !directory) return null
        const keyBase = 'oc-tailnet-sync:' + encodeURIComponent(dirToken || 'global') + ':' + encodeURIComponent(routeSessionID || 'none')
        return {
          dirToken,
          sessionID: routeSessionID,
          directory,
          keyBase,
          key: keyBase + ':last-action',
          msgKey: keyBase + ':last-head',
          route: location.pathname + location.search,
        }
      } catch {
        return null
      }
    }
    const ready = () => document.visibilityState === 'visible' && document.hasFocus()
    const fetchJson = async (path) => {
      const res = await fetch(withBase(path), { credentials: 'same-origin', cache: 'no-store' })
      return await res.json()
    }
    const withView = (path) => {
      const view = currentView()
      if (!view?.directory || !view?.sessionID) return path
      return path + (path.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent(view.directory) + '&sessionID=' + encodeURIComponent(view.sessionID)
    }
    const apply = async () => {
      const view = currentView()
      if (!view?.directory || !view?.sessionID) return
      const routeAtStart = view.route || ''
      const data = await fetchJson(withView('/__oc/progress'))
      if (data.meta) {
        ${compatBootstrapRuntime("{ host, port }", "data.meta")}
      }
      if ((currentView()?.route || '') !== routeAtStart) return
      window.__ocTailnetSync.state = data.syncState || 'live'
      window.__ocTailnetSync.lastAction = data.lastAction || 'noop'
      window.__ocTailnetSync.staleReason = data.staleReason || null
      if (!ready()) return
    }
    const pulse = async () => {
      await apply()
    }
     const onRouteChange = (previousView) => {
      const nextView = currentView()
      const changedSession = Boolean(
        previousView &&
        nextView &&
        (previousView.sessionID !== nextView.sessionID || previousView.directory !== nextView.directory)
      )
      if (changedSession) void pulse()
     }
     const originalPushState = history.pushState
     history.pushState = function () {
      const previousView = currentView()
      const result = originalPushState.apply(this, arguments)
      onRouteChange(previousView)
      return result
     }
     const originalReplaceState = history.replaceState
     history.replaceState = function () {
      const previousView = currentView()
      const result = originalReplaceState.apply(this, arguments)
      onRouteChange(previousView)
      return result
     }
     window.__ocTailnetSync = { mode: 'active', state: 'live', lastAction: 'noop', staleReason: null }
     const stream = new EventSource('/__oc/events' + base)
     stream.addEventListener('sync-stale', () => void pulse())
     stream.addEventListener('message-appended', () => void pulse())
     stream.addEventListener('target-health-changed', () => void pulse())
     stream.onerror = () => void pulse()
     document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void pulse() })
     window.addEventListener('focus', () => void pulse())
     window.addEventListener('popstate', () => onRouteChange(null))
     setInterval(() => void pulse(), 15000)
     void pulse()
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
