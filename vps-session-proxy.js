const http = require("http")

const host = process.env.OPENCODE_PROXY_HOST || "127.0.0.1"
const port = Number(process.env.OPENCODE_PROXY_PORT || "33101")

function respondJson(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(JSON.stringify(body))
}

function validTailnetIp(value) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false
  const parts = value.split(".").map(Number)
  if (parts.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false
  const num = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
  const start = ((100 << 24) >>> 0) + (64 << 16)
  const end = ((100 << 24) >>> 0) + (127 << 16) + (255 << 8) + 255
  return num >= start && num <= end
}

function validPort(value) {
  return /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) < 65536
}

async function loadJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`Upstream returned ${response.status}`)
  return response.json()
}

function sortSessions(items) {
  return [...items].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

  if (url.pathname === "/health") {
    respondJson(res, 200, { healthy: true })
    return
  }

  if (url.pathname !== "/scan") {
    respondJson(res, 404, { error: "Not found" })
    return
  }

  const targetHost = (url.searchParams.get("host") || "100.121.130.36").trim()
  const targetPort = (url.searchParams.get("port") || "3000").trim()
  const query = (url.searchParams.get("query") || "").trim().toLowerCase()
  const limitRaw = Number(url.searchParams.get("limit") || "200")
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500) : 200

  if (!validTailnetIp(targetHost)) {
    respondJson(res, 400, { error: "Target host must be a Tailscale IPv4 address" })
    return
  }

  if (!validPort(targetPort)) {
    respondJson(res, 400, { error: "Invalid target port" })
    return
  }

  const base = `http://${targetHost}:${targetPort}`

  try {
    const [health, rawSessions] = await Promise.all([
      loadJson(`${base}/global/health`),
      loadJson(`${base}/session?limit=${limit}`),
    ])

    const sessions = sortSessions(Array.isArray(rawSessions) ? rawSessions : []).filter((item) => {
      if (!query) return true
      const haystack = [item.title, item.slug, item.id, item.directory].filter(Boolean).join(" ").toLowerCase()
      return haystack.includes(query)
    })

    const byDirectory = new Map()
    for (const session of sessions) {
      const dir = session.directory || "(unknown)"
      const list = byDirectory.get(dir) || []
      list.push(session)
      byDirectory.set(dir, list)
    }

    const directories = Array.from(byDirectory.entries())
      .map(([directory, items]) => ({
        directory,
        count: items.length,
        latest: sortSessions(items)[0],
      }))
      .sort((a, b) => (b.latest?.time?.updated ?? b.latest?.time?.created ?? 0) - (a.latest?.time?.updated ?? a.latest?.time?.created ?? 0))

    respondJson(res, 200, {
      targetHost,
      targetPort,
      health,
      count: sessions.length,
      directories,
      sessions,
    })
  } catch (error) {
    respondJson(res, 502, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

server.listen(port, host, () => {
  console.log(`OpenCode VPS session proxy listening on http://${host}:${port}`)
})
