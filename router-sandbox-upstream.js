const crypto = require("crypto")
const http = require("http")

const port = Number(process.env.SANDBOX_UPSTREAM_PORT || "3400")
const directory = process.env.SANDBOX_DIRECTORY || "D:\\CODE"
const directories = String(process.env.SANDBOX_DIRECTORIES || directory).split('|').map((item) => item.trim()).filter(Boolean)
const sessionCount = Math.max(1, Number(process.env.SANDBOX_SESSION_COUNT || "4"))
const delays = {
  health: 40,
  session: 140,
  message: 180,
  detail: 90,
}
const counts = {
  health: 0,
  session: 0,
  message: 0,
  detail: 0,
  config: 0,
  provider: 0,
  path: 0,
  project: 0,
  status: 0,
  html: 0,
}
const fails = {
  health: 0,
  session: 0,
  message: 0,
  detail: 0,
}
const stalls = {
  html: false,
  health: false,
  session: false,
  message: false,
}
let offline = false
const stallMessageIDs = new Set()
const stallHtmlIDs = new Set()
const extraMessages = new Map()

const baseSessions = [
  { id: "ses_latest", title: "Sandbox Session", directory: directories[0], time: { created: 4, updated: 8 } },
  { id: "ses_prev", title: "Previous Session", directory: directories[0], time: { created: 3, updated: 7 } },
  { id: "ses_old", title: "Older Session", directory: directories[0], time: { created: 2, updated: 6 } },
  { id: "ses_older", title: "Oldest Session", directory: directories[0], time: { created: 1, updated: 5 } },
]
const extraSessions = Array.from({ length: Math.max(0, sessionCount - baseSessions.length) }, (_, index) => ({
  id: `ses_extra_${index + 1}`,
  title: `Extra Session ${index + 1}`,
  directory: directories[index % directories.length],
  time: { created: Math.max(1, 100 - index), updated: Math.max(1, 200 - index) },
}))
const sessions = [...baseSessions, ...extraSessions].slice(0, sessionCount)

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
  })
  res.end(type === "application/json" ? JSON.stringify(body) : body)
}

function fail(name, res) {
  if (!fails[name]) return false
  fails[name] -= 1
  send(res, 500, { error: `${name} failed` }, "application/json")
  return true
}

function message(sessionID, limit) {
  const total = 3 + (extraMessages.get(sessionID) || 0)
  return Array.from({ length: Math.min(limit, total) }, (_, index) => ({
    info: {
      id: `${sessionID}_msg_${index + 1}`,
      sessionID,
      role: index % 2 ? "assistant" : "user",
      time: { created: index + 1, updated: index + 1 },
    },
    parts: [
      {
        id: `${sessionID}_part_${index + 1}`,
        messageID: `${sessionID}_msg_${index + 1}`,
        sessionID,
        type: "text",
        text: `${sessionID} message ${index + 1}`,
      },
    ],
  }))
}

function html(pathname) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sandbox App</title>
</head>
<body>
  <div id="route">${pathname}</div>
  <div id="config">loading</div>
  <script>
    fetch('/global/config', { credentials: 'same-origin' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        document.getElementById('config').textContent = data.mode || 'missing'
        document.body.dataset.mode = data.mode || ''
      })
      .catch(function (err) {
        document.getElementById('config').textContent = err.message || String(err)
        document.body.dataset.mode = 'error'
      })
  </script>
</body>
</html>`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

  if (url.pathname === "/__debug/counts") {
    send(res, 200, counts, "application/json")
    return
  }

  if (url.pathname === "/__debug/fail") {
    const name = String(url.searchParams.get("name") || "")
    const times = Math.max(0, Number(url.searchParams.get("times") || "1"))
    if (!(name in fails)) {
      send(res, 400, { error: "unknown fail route" }, "application/json")
      return
    }
    fails[name] = times
    send(res, 200, { ok: true, name, times }, "application/json")
    return
  }

  if (url.pathname === "/__debug/stall") {
    const name = String(url.searchParams.get("name") || "")
    const enabled = url.searchParams.get("enabled") !== "false"
    if (!(name in stalls)) {
      send(res, 400, { error: "unknown stall route" }, "application/json")
      return
    }
    stalls[name] = enabled
    send(res, 200, { ok: true, name, enabled }, "application/json")
    return
  }

  if (url.pathname === "/__debug/stall-message") {
    const ids = String(url.searchParams.get("ids") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    const enabled = url.searchParams.get("enabled") !== "false"
    if (!enabled) stallMessageIDs.clear()
    else {
      stallMessageIDs.clear()
      ids.forEach((id) => stallMessageIDs.add(id))
    }
    send(res, 200, { ok: true, ids: [...stallMessageIDs], enabled }, "application/json")
    return
  }

  if (url.pathname === "/__debug/stall-html") {
    const ids = String(url.searchParams.get("ids") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    const enabled = url.searchParams.get("enabled") !== "false"
    if (!enabled) stallHtmlIDs.clear()
    else {
      stallHtmlIDs.clear()
      ids.forEach((id) => stallHtmlIDs.add(id))
    }
    send(res, 200, { ok: true, ids: [...stallHtmlIDs], enabled }, "application/json")
    return
  }

  if (url.pathname === "/__debug/append-message") {
    const sessionID = String(url.searchParams.get("session") || "")
    const count = Math.max(0, Number(url.searchParams.get("count") || "1"))
    extraMessages.set(sessionID, (extraMessages.get(sessionID) || 0) + count)
    send(res, 200, { ok: true, sessionID, count: extraMessages.get(sessionID) }, "application/json")
    return
  }

  if (url.pathname === "/__debug/offline") {
    offline = url.searchParams.get("enabled") !== "false"
    send(res, 200, { ok: true, offline }, "application/json")
    return
  }

  if (url.pathname === "/global/health") {
    if (offline) {
      send(res, 503, { error: "offline" }, "application/json")
      return
    }
    counts.health += 1
    if (fail("health", res)) return
    if (stalls.health) return
    await pause(delays.health)
    send(res, 200, { healthy: true, version: "sandbox" }, "application/json")
    return
  }

  if (url.pathname === "/session") {
    if (offline) {
      send(res, 503, { error: "offline" }, "application/json")
      return
    }
    counts.session += 1
    if (fail("session", res)) return
    if (stalls.session) return
    await pause(delays.session)
    const dir = url.searchParams.get("directory")
    const limit = Number(url.searchParams.get("limit") || "80")
    const list = dir ? sessions.filter((item) => item.directory === dir).slice(0, limit) : sessions.slice(0, limit)
    send(res, 200, list, "application/json")
    return
  }

  const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (messageMatch) {
    if (offline) {
      send(res, 503, { error: "offline" }, "application/json")
      return
    }
    counts.message += 1
    if (fail("message", res)) return
    const sessionID = decodeURIComponent(messageMatch[1])
    if (stalls.message || stallMessageIDs.has(sessionID)) return
    await pause(delays.message)
    const limit = Number(url.searchParams.get("limit") || "80")
    send(res, 200, message(sessionID, limit), "application/json")
    return
  }

  if (url.pathname === "/global/config") {
    counts.config += 1
    send(res, 200, { mode: "ok", providers: [] }, "application/json")
    return
  }

  if (url.pathname === "/provider") {
    counts.provider += 1
    send(res, 200, { all: [] }, "application/json")
    return
  }

  if (url.pathname === "/path") {
    counts.path += 1
    send(res, 200, { directory }, "application/json")
    return
  }

  if (url.pathname === "/project") {
    counts.project += 1
    send(res, 200, directories.map((dir, index) => ({ id: `proj_${index + 1}`, worktree: dir, sandboxes: [], icon: {}, time: { created: index + 1, updated: index + 1 } })), "application/json")
    return
  }

  if (url.pathname === "/project/current") {
    counts.project += 1
    const current = url.searchParams.get('directory') || directory
    const index = Math.max(0, directories.indexOf(current))
    send(res, 200, { id: `proj_${index + 1}`, worktree: current, sandboxes: [] }, "application/json")
    return
  }

  if (url.pathname === "/session/status") {
    counts.status += 1
    send(res, 200, { active: true }, "application/json")
    return
  }

  const detailMatch = url.pathname.match(/^\/session\/([^/]+)$/)
  if (detailMatch) {
    if (offline) {
      send(res, 503, { error: "offline" }, "application/json")
      return
    }
    counts.detail += 1
    if (fail("detail", res)) return
    await pause(delays.detail)
    const sessionID = decodeURIComponent(detailMatch[1])
    send(res, 200, { id: sessionID, directory, title: sessionID, sharing: { disabled: true } }, "application/json")
    return
  }

  counts.html += 1
  if (offline) {
    send(res, 503, "offline", "text/plain")
    return
  }
  if ([...stallHtmlIDs].some((id) => url.pathname.includes(id))) return
  if (stalls.html) return
  send(res, 200, html(url.pathname), "text/html")
})

server.listen(port, "127.0.0.1", () => {
  console.log(`Sandbox upstream listening on http://127.0.0.1:${port}`)
})

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
  if (!/^\/pty\/[^/]+\/connect$/.test(url.pathname)) {
    socket.destroy()
    return
  }
  const key = req.headers["sec-websocket-key"]
  if (!key) {
    socket.destroy()
    return
  }
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"))
  socket.on("error", () => {})
})
