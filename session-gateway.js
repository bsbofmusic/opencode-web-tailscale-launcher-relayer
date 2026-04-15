const http = require("http")
const fs = require("fs")
const path = require("path")

const host = process.env.OPENCODE_GATEWAY_HOST || "100.121.130.36"
const port = Number(process.env.OPENCODE_GATEWAY_PORT || "3101")
const page = fs.readFileSync(path.join(__dirname, "session-gateway.html"), "utf8")

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(body))
}

function text(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  })
  res.end(body)
}

function validHost(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)
}

function validPort(value) {
  return /^\d{1,5}$/.test(value)
}

function sessionUrl(targetHost, targetPort, directory, limit) {
  const url = new URL(`http://${targetHost}:${targetPort}/session`)
  url.searchParams.set("directory", directory)
  url.searchParams.set("roots", "true")
  url.searchParams.set("limit", String(limit))
  return url
}

async function loadSessions(targetHost, targetPort, directory, limit) {
  const response = await fetch(sessionUrl(targetHost, targetPort, directory, limit), {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`OpenCode session API returned ${response.status}`)
  }

  const data = await response.json()
  if (!Array.isArray(data)) return []
  return data
    .filter((item) => item && typeof item.id === "string")
    .filter((item) => item.directory === directory)
    .sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

  if (url.pathname === "/") {
    text(res, 200, page, "text/html; charset=utf-8")
    return
  }

  if (url.pathname === "/health") {
    json(res, 200, { healthy: true, host, port })
    return
  }

  if (url.pathname === "/api/sessions") {
    const targetHost = (url.searchParams.get("host") || host).trim()
    const targetPort = (url.searchParams.get("port") || "3000").trim()
    const directory = (url.searchParams.get("dir") || "D:\\CODE").trim()
    const limitRaw = Number(url.searchParams.get("limit") || "50")
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 50

    if (!validHost(targetHost)) {
      json(res, 400, { error: "Invalid target host" })
      return
    }

    if (!validPort(targetPort)) {
      json(res, 400, { error: "Invalid target port" })
      return
    }

    if (!directory) {
      json(res, 400, { error: "Directory is required" })
      return
    }

    try {
      const sessions = await loadSessions(targetHost, targetPort, directory, limit)
      json(res, 200, {
        targetHost,
        targetPort,
        directory,
        count: sessions.length,
        sessions,
      })
    } catch (error) {
      json(res, 502, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (url.pathname === "/favicon.ico") {
    res.writeHead(204)
    res.end()
    return
  }

  json(res, 404, { error: "Not found" })
})

server.listen(port, host, () => {
  console.log(`OpenCode session gateway listening on http://${host}:${port}`)
})
