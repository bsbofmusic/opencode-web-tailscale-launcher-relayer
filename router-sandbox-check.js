const assert = require("assert")
const crypto = require("crypto")
const fs = require("fs")
const net = require("net")
const path = require("path")
const { spawn } = require("child_process")

const routerPort = Number(process.env.SANDBOX_ROUTER_PORT || "33113")
const upstreamPort = Number(process.env.SANDBOX_UPSTREAM_PORT || "3410")
const base = `http://127.0.0.1:${routerPort}`
const target = `host=127.0.0.1&port=${upstreamPort}`
const directory = process.env.SANDBOX_DIRECTORY || "D:\\CODE"
const cwd = __dirname
const cacheRootBase = path.join(cwd, ".tmp-router-cache-tests")

function withClient(id) {
  return `${target}&client=${encodeURIComponent(id)}`
}

function encodeDir(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getJson(url, init) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), ...(init || {}) })
  const text = await res.text()
  return { res, data: text ? JSON.parse(text) : {} }
}

function makeCacheDir() {
  fs.mkdirSync(cacheRootBase, { recursive: true })
  return fs.mkdtempSync(path.join(cacheRootBase, "case-"))
}

function cleanupDir(dir) {
  if (!dir) return
  fs.rmSync(dir, { recursive: true, force: true })
}

function startNode(file, env) {
  const child = spawn(process.execPath, [path.join(cwd, file)], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  child.stdout.on("data", () => {})
  child.stderr.on("data", () => {})
  return child
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (res.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function withServers(opts, fn) {
  const config = opts || {}
  const up = startNode("router-sandbox-upstream.js", {
    SANDBOX_UPSTREAM_PORT: String(upstreamPort),
    SANDBOX_DIRECTORY: directory,
    SANDBOX_SESSION_COUNT: String(config.sessionCount || 4),
    SANDBOX_DIRECTORIES: config.directories || directory,
  })
  const rt = startNode("vps-opencode-router.js", {
    OPENCODE_ROUTER_PORT: String(routerPort),
    OPENCODE_ROUTER_INSPECT_TIMEOUT_MS: String(config.inspectTimeoutMs || 5000),
    OPENCODE_ROUTER_WARM_TIMEOUT_MS: String(config.warmTimeoutMs || 7000),
    OPENCODE_ROUTER_HTML_TIMEOUT_MS: String(config.htmlTimeoutMs || 8000),
    OPENCODE_ROUTER_META_CACHE_MS: String(config.metaCacheMs || 15000),
    OPENCODE_ROUTER_SNAPSHOT_CACHE_MS: String(config.snapshotCacheMs || 45000),
    OPENCODE_ROUTER_IDLE_RECOVERY_THRESHOLD_MS: String(config.idleRecoveryThresholdMs || 300000),
    OPENCODE_ROUTER_IDLE_RECOVERY_WINDOW_MS: String(config.idleRecoveryWindowMs || 30000),
    OPENCODE_ROUTER_RECOVERY_RETRY_MS: String(config.recoveryRetryMs || 1500),
    OPENCODE_ROUTER_RECOVERY_HTML_TIMEOUT_MS: String(config.recoveryHtmlTimeoutMs || 15000),
    OPENCODE_ROUTER_CACHE_DIR: config.cacheDir || "",
    OPENCODE_ROUTER_WATCH_INTERVAL_MS: String(config.watchIntervalMs || 0),
    OPENCODE_ROUTER_LAUNCHER_HOSTS: config.launcherHosts || "",
  })
  try {
    await waitFor(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    await waitFor(`${base}/`)
    return await fn()
  } finally {
    rt.kill()
    up.kill()
  }
}

async function connectSse(url) {
  const res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal: AbortSignal.timeout(60000) })
  const reader = res.body.getReader()
  let text = ""
  return {
    res,
    async waitFor(substr, tries = 40) {
      for (let i = 0; i < tries; i++) {
        const { value, done } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString("utf8")
        if (text.includes(substr)) return text
      }
      throw new Error(`Timed out waiting for SSE payload containing ${substr}`)
    },
    async close() {
      try { await reader.cancel() } catch {}
    },
  }
}

async function waitLaunchReady(query = target) {
  for (let i = 0; i < 80; i++) {
    const progress = await getJson(`${base}/__oc/progress?${query}`)
    if (progress.data.launchReady) return progress.data
    await sleep(350)
  }
  throw new Error("Timed out waiting for router launch-ready state")
}

async function waitBackgroundReady(query = target) {
  for (let i = 0; i < 80; i++) {
    const progress = await getJson(`${base}/__oc/progress?${query}`)
    if (progress.data.ready && progress.data.refreshing === false) return progress.data
    await sleep(150)
  }
  throw new Error("Timed out waiting for router background cache")
}

async function waitRefreshing(expected, query = target, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const progress = await getJson(`${base}/__oc/progress?${query}`)
    if (progress.data.refreshing === expected) return progress.data
    await sleep(100)
  }
  throw new Error(`Timed out waiting for refreshing=${expected}`)
}

async function openSocket(pathname) {
  return await new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64")
    const socket = net.connect(routerPort, "127.0.0.1")
    let buf = ""
    const fail = (err) => reject(err instanceof Error ? err : new Error(String(err)))
    socket.once("error", fail)
    socket.on("connect", () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${routerPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`,
      )
    })
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8")
      if (!buf.includes("\r\n\r\n")) return
      socket.removeListener("error", fail)
      if (!buf.startsWith("HTTP/1.1 101")) {
        reject(new Error(buf))
        socket.destroy()
        return
      }
      socket.on("error", () => {})
      resolve(socket)
    })
  })
}

async function run() {
  await withServers({}, async () => {
    const client = withClient("client_launch1")
    const landing = await fetch(`${base}/`, { headers: { cookie: `oc_target=127.0.0.1:${upstreamPort}` } })
    const landingText = await landing.text()
    assert.equal(landing.status, 200)
    assert(landingText.includes('value=""'))
    assert(landingText.includes('value="3000"'))
    assert.equal(landingText.includes("oc-tailnet-sync-runtime"), false)

    const start = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(start.res.status, 200)

    const launch = await fetch(`${base}/__oc/launch?${client}`, { redirect: "manual" })
    if (launch.status === 200) {
      const launchText = await launch.text()
      assert(launchText.includes("/__oc/progress"))
      assert(launchText.includes("Launching Remote OpenCode"))
    } else {
      assert.equal(launch.status, 303)
      assert(launch.headers.get("location").includes(`/${encodeDir(directory)}/session/ses_latest`))
    }

    const progress = await getJson(`${base}/__oc/progress?${client}`)
    assert.equal(progress.res.status, 200)
    assert.equal(progress.data.targetType, "attach-only")
    assert(progress.data.admission === "probe" || progress.data.admission === "enter")
    assert(progress.data.cacheState === "cold" || progress.data.cacheState === "stale" || progress.data.cacheState === "warm")

    const launchReady = await waitLaunchReady(client)
    assert.equal(launchReady.launchReady, true)
    assert.equal(launchReady.meta.sessions.latest.id, "ses_latest")
    assert.equal(launchReady.launch.directory, encodeDir(directory))
    assert(launchReady.refreshing === true || launchReady.refreshing === false)

    const handoff = await fetch(`${base}/__oc/launch?${client}`, { redirect: "manual" })
    const handoffText = await handoff.text()
    assert.equal(handoff.status, 200)
    assert(handoffText.includes("/__oc/progress"))
    assert(handoffText.includes("Launching Remote OpenCode"))

    const ready = await waitBackgroundReady(client)
    assert.equal(ready.ready, true)
    assert.equal(ready.refreshing, false)
    assert.equal(ready.syncState, "live")
    assert.equal(ready.lastAction, "noop")
    assert.equal(ready.staleReason, null)
    assert.equal(ready.viewHead.sessionID, "ses_latest")
    assert.equal(ready.viewHead.directory, directory)
    assert.equal(ready.viewHead.messageCount, 3)
    assert.equal(ready.remoteHead.sessionID, "ses_latest")
    assert.equal(ready.remoteHead.messageCount, 3)

    const meta = await getJson(`${base}/__oc/meta?${client}`)
    assert.equal(meta.res.status, 200)
    assert.equal(meta.data.ready, true)
    assert.equal(meta.data.cache.source, "router")
    assert.equal(meta.data.targetType, "attach-only")
    assert(meta.data.admission === "probe" || meta.data.admission === "enter")

    const afterWarm = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(afterWarm.res.status, 200)
    assert.equal(afterWarm.data.health - start.data.health, 1)
    assert.equal(afterWarm.data.session - start.data.session, 1)
    assert.equal(afterWarm.data.detail - start.data.detail, 1)
    assert.equal(afterWarm.data.message - start.data.message, 2)

    const list = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${target}`)
    const listText = await list.text()
    assert.equal(list.status, 200)
    assert.equal(list.headers.get("x-oc-cache"), "hit")
    assert.equal(list.headers.get("x-oc-relay-mode"), "cache")
    assert(listText.includes("ses_latest"))

    const current = await fetch(`${base}/session/ses_latest/message?limit=80&directory=${encodeURIComponent(directory)}&${target}`)
    const currentText = await current.text()
    assert.equal(current.status, 200)
    assert.equal(current.headers.get("x-oc-cache"), "hit")
    assert.equal(current.headers.get("x-oc-relay-priority"), "foreground")
    assert.equal(current.headers.get("x-oc-relay-mode"), "cache")
    assert.equal(current.headers.get("x-oc-relay-reason"), "cache-hit")
    assert(currentText.includes("ses_latest_msg_1"))

    const older = await fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${target}`)
    const olderText = await older.text()
    assert.equal(older.status, 200)
    assert.equal(older.headers.get("x-oc-cache"), "hit")
    assert.equal(older.headers.get("x-oc-relay-priority"), "foreground")
    assert.equal(older.headers.get("x-oc-relay-mode"), "cache")
    assert.equal(older.headers.get("x-oc-relay-reason"), "cache-hit")
    assert(olderText.includes("ses_prev_msg_1"))

    const detail = await fetch(`${base}/session/ses_latest?directory=${encodeURIComponent(directory)}&${target}`)
    const detailText = await detail.text()
    assert.equal(detail.status, 200)
    assert.equal(detail.headers.get("x-oc-cache"), "hit")
    assert(detailText.includes("ses_latest"))

    const finalCounts = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(finalCounts.res.status, 200)
    assert.equal(finalCounts.data.message, afterWarm.data.message)
    assert.equal(finalCounts.data.detail, afterWarm.data.detail)

    const cachedAgain = await fetch(`${base}/session/ses_latest/message?limit=80&directory=${encodeURIComponent(directory)}&${target}`)
    assert.equal(cachedAgain.status, 200)
    assert.equal(cachedAgain.headers.get("x-oc-cache"), "hit")

    const proxied = await fetch(`${base}/${encodeDir(directory)}/session/ses_latest?${target}`)
    const proxiedText = await proxied.text()
    assert.equal(proxied.status, 200)
    assert(proxiedText.includes("Sandbox App"))
    assert.equal((proxiedText.match(/oc-tailnet-sync-runtime/g) || []).length, 1)
    assert(proxiedText.includes("setInterval"))
    assert.equal(proxied.headers.get("x-oc-relay-sync-state"), "live")
    assert.equal(proxied.headers.get("x-oc-relay-action"), "noop")

    const icon = await fetch(`${base}/favicon.ico`)
    assert.equal(icon.status, 204)
  })

  await withServers({ sessionCount: 1 }, async () => {
    const client = withClient("client_single1")
    await fetch(`${base}/__oc/launch?${client}`)
    const launchReady = await waitLaunchReady(client)
    assert.equal(launchReady.launchReady, true)
    const ready = await waitBackgroundReady(client)
    assert.equal(ready.refreshing, false)
    const health = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(health.res.status, 200)
    assert.equal(health.data.states[0].refreshing, false)
    assert.equal(health.data.states[0].backgroundActive, 0)
    assert.equal(health.data.states[0].backgroundQueued, 0)
  })

  await withServers({ sessionCount: 70 }, async () => {
    const roots55 = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${target}`)
    const body55 = await roots55.text()
    assert.equal(roots55.status, 200)
    assert.notEqual(roots55.headers.get("x-oc-cache"), "hit")
    const list55 = JSON.parse(body55)
    assert.equal(list55.length, 55)

    const roots60 = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=60&${target}`)
    const body60 = await roots60.text()
    assert.equal(roots60.status, 200)
    assert.notEqual(roots60.headers.get("x-oc-cache"), "hit")
    const list60 = JSON.parse(body60)
    assert.equal(list60.length, 60)
    assert(list60.some((item) => item.id === "ses_extra_56"))
  })

  await withServers({ sessionCount: 20, directories: 'D:\\CODE|E:\\code' }, async () => {
    const client = withClient('client_multiroot1')
    const meta = await getJson(`${base}/__oc/meta?${client}`)
    assert.equal(meta.res.status, 200)
    assert(meta.data.sessions.directories.includes('D:\\CODE'))
    assert(meta.data.sessions.directories.includes('E:\\code'))
    assert(meta.data.projects)
    assert(meta.data.projects.roots.includes('D:\\CODE'))
    assert(meta.data.projects.roots.includes('E:\\code'))
  })

  await withServers({}, async () => {
    const fail = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/fail?name=detail&times=1`)
    assert.equal(fail.res.status, 200)
    const first = await fetch(`${base}/session/ses_old?directory=${encodeURIComponent(directory)}&${target}`)
    const firstText = await first.text()
    assert.equal(first.status, 500)
    assert(firstText.includes("detail failed"))
    const second = await fetch(`${base}/session/ses_old?directory=${encodeURIComponent(directory)}&${target}`)
    const secondText = await second.text()
    assert.equal(second.status, 200)
    assert.notEqual(second.headers.get("x-oc-cache"), "hit")
    assert(secondText.includes("ses_old"))
  })

  await withServers({ htmlTimeoutMs: 300 }, async () => {
    const stall = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall?name=html&enabled=true`)
    assert.equal(stall.res.status, 200)
    const proxied = await fetch(`${base}/${encodeDir(directory)}/session/ses_latest?${target}`)
    const proxiedText = await proxied.text()
    assert.equal(proxied.status, 504)
    assert(proxiedText.includes("session page is taking too long"))
    assert.equal(proxied.headers.get("x-oc-relay-mode"), "fallback")
    assert.equal(proxied.headers.get("x-oc-relay-reason"), "html-timeout")
    const health = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(health.res.status, 200)
    assert.equal(health.data.states[0].lastReason, "html-timeout")
    assert.equal(health.data.states[0].lastReasonClient, "_shared")
    const recovered = await getJson(`${base}/__oc/meta?${target}`)
    assert.equal(recovered.res.status, 200)
    const healed = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(healed.res.status, 200)
    assert.equal(healed.data.states[0].lastReason, null)
  })

  await withServers({ inspectTimeoutMs: 3000, warmTimeoutMs: 4000 }, async () => {
    const client = withClient("client_fast_launch1")
    const stall = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall?name=session&enabled=true`)
    assert.equal(stall.res.status, 200)
    const started = Date.now()
    const launch = await fetch(`${base}/__oc/launch?${client}`, { redirect: "manual" })
    const elapsed = Date.now() - started
    assert.equal(launch.status, 200)
    assert(elapsed < 700, `expected fast-path launch response, got ${elapsed}ms`)
  })

  await withServers({ inspectTimeoutMs: 300, warmTimeoutMs: 500, metaCacheMs: 300, snapshotCacheMs: 100 }, async () => {
    const meta = await getJson(`${base}/__oc/meta?${target}`)
    assert.equal(meta.res.status, 200)
    const list = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${target}`)
    assert.equal(list.status, 200)
    const stall = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall?name=session&enabled=true`)
    assert.equal(stall.res.status, 200)
    await sleep(350)
    const cached = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${target}`)
    assert.equal(cached.status, 200)
    assert.notEqual(cached.headers.get("x-oc-cache"), "hit")
    await waitRefreshing(true)
    await waitRefreshing(false)
    const health = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(health.res.status, 200)
    assert.equal(health.data.states[0].promiseActive, false)
    assert.equal(health.data.states[0].refreshing, false)
    assert(health.data.states[0].stats.staleLaunch >= 1)
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, idleRecoveryThresholdMs: 200, idleRecoveryWindowMs: 800, recoveryRetryMs: 1200 }, async () => {
    const client = withClient("client_idle_resume1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const before = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(before.res.status, 200)
    await sleep(250)
    const resumed = await getJson(`${base}/__oc/meta?${client}`)
    assert.equal(resumed.res.status, 200)
    const progress = await getJson(`${base}/__oc/progress?${client}`)
    assert.equal(progress.res.status, 200)
    assert.equal(progress.data.resumeSafeMode, true)
    assert.equal(progress.data.backgroundWarmPaused, true)
    assert(progress.data.retryAfterMs >= 1200)
    await sleep(200)
    const after = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(after.res.status, 200)
    assert.equal(after.data.detail, before.data.detail)
    assert.equal(after.data.message, before.data.message)
    const health = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(health.res.status, 200)
    assert.equal(health.data.states[0].backgroundWarmPaused, true)
    assert(health.data.states[0].resumeSafeClients >= 1)
    await sleep(900)
    const resumedHealth = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(resumedHealth.res.status, 200)
    assert.equal(resumedHealth.data.states[0].backgroundWarmPaused, false)
    for (let i = 0; i < 10; i++) {
      const latest = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
      if (latest.data.detail > before.data.detail || latest.data.message > before.data.message) {
        assert.equal(true, true)
        return
      }
      await sleep(150)
    }
    assert.fail("background warm did not resume after idle recovery window")
  })

  await withServers({ inspectTimeoutMs: 300, warmTimeoutMs: 500, metaCacheMs: 300, snapshotCacheMs: 100 }, async () => {
    const clientA = withClient("client_a123")
    const clientB = withClient("client_b456")
    const meta = await getJson(`${base}/__oc/meta?${clientA}`)
    assert.equal(meta.res.status, 200)
    const list = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${clientA}`)
    assert.equal(list.status, 200)
    const stall = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall?name=session&enabled=true`)
    assert.equal(stall.res.status, 200)
    await sleep(350)
    const cached = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${clientA}`)
    assert.equal(cached.status, 200)
    assert.notEqual(cached.headers.get("x-oc-cache"), "hit")
    await waitRefreshing(true, clientA)
    const other = await getJson(`${base}/__oc/progress?${clientB}`)
    assert.equal(other.res.status, 200)
    assert.equal(other.data.refreshing, false)
    assert.equal(other.data.launchReady, true)
    await waitRefreshing(false, clientA)
  })

  await withServers({ metaCacheMs: 100 }, async () => {
    await getJson(`${base}/__oc/meta?${target}`)
    const before = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(before.res.status, 200)
    await sleep(150)
    await getJson(`${base}/__oc/progress?${target}`)
    await getJson(`${base}/__oc/progress?${target}`)
    const after = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(after.res.status, 200)
    assert.equal(after.data.health, before.data.health)
    assert.equal(after.data.session, before.data.session)
  })

  await withServers({}, async () => {
    const stall = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall?name=message&enabled=true`)
    assert.equal(stall.res.status, 200)
    void fetch(`${base}/session/ses_latest/message?limit=80&directory=${encodeURIComponent(directory)}&${target}`).catch(() => {})
    void fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${target}`).catch(() => {})
    await sleep(100)
    const status = await fetch(`${base}/session/status?${target}`, { signal: AbortSignal.timeout(1000) })
    const text = await status.text()
    assert.equal(status.status, 200)
    assert(text.includes("active"))
  })

  await withServers({}, async () => {
    const client = withClient("client_history1")
    const shell = await fetch(`${base}/${encodeDir(directory)}/session/ses_latest?${client}`)
    assert.equal(shell.status, 200)
    const background = await fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`)
    const foreground = await fetch(`${base}/session/ses_latest/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`)
    assert.equal(background.headers.get("x-oc-relay-priority"), "background")
    assert.equal(foreground.headers.get("x-oc-relay-priority"), "foreground")
    const stall = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall-message?ids=ses_prev,ses_old&enabled=true`)
    assert.equal(stall.res.status, 200)
    void fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`).catch(() => {})
    void fetch(`${base}/session/ses_old/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`).catch(() => {})
    await sleep(100)
    const activeHistory = await fetch(`${base}/session/ses_latest/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`, { signal: AbortSignal.timeout(1200) })
    const text = await activeHistory.text()
    assert.equal(activeHistory.status, 200)
    assert(text.includes("ses_latest_msg_1"))
  })

  await withServers({}, async () => {
    const client = withClient("client_latest_fresh1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const first = await fetch(`${base}/session/ses_latest/message?limit=80&directory=${encodeURIComponent(directory)}&${client}`)
    const firstText = await first.text()
    assert.equal(first.status, 200)
    assert(firstText.includes("ses_latest_msg_3"))
    const bump = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_latest&count=1`)
    assert.equal(bump.res.status, 200)
    const second = await fetch(`${base}/session/ses_latest/message?limit=80&directory=${encodeURIComponent(directory)}&${client}`)
    const secondText = await second.text()
    assert.equal(second.status, 200)
    assert(secondText.includes("ses_latest_msg_4"))
    assert.notEqual(second.headers.get("x-oc-cache"), "hit")
    const health = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(health.res.status, 200)
    assert.equal(health.data.states[0].stats.cacheBypass, 2)
  })

  await withServers({}, async () => {
    const client = withClient("client_active_fresh1")
    const shell = await fetch(`${base}/${encodeDir(directory)}/session/ses_prev?${client}`)
    assert.equal(shell.status, 200)
    const first = await fetch(`${base}/session/ses_prev/message?limit=80&${client}`)
    const firstText = await first.text()
    assert.equal(first.status, 200)
    assert(firstText.includes("ses_prev_msg_3"))
    const bump = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_prev&count=1`)
    assert.equal(bump.res.status, 200)
    const second = await fetch(`${base}/session/ses_prev/message?limit=80&${client}`)
    const secondText = await second.text()
    assert.equal(second.status, 200)
    assert(secondText.includes("ses_prev_msg_4"))
    assert.notEqual(second.headers.get("x-oc-cache"), "hit")
    assert.equal(second.headers.get("x-oc-relay-reason"), "active-session-bypass")
    const paged = await fetch(`${base}/session/ses_prev/message?limit=80&cursor=older&${client}`)
    assert.equal(paged.status, 200)
    assert.notEqual(paged.headers.get("x-oc-cache"), "bypass")
    assert.equal(paged.headers.get("x-oc-relay-reason"), "proxy-pass")
  })

  await withServers({ htmlTimeoutMs: 300 }, async () => {
    const client = withClient("client_failed_html1")
    const ok = await fetch(`${base}/${encodeDir(directory)}/session/ses_latest?${client}`)
    assert.equal(ok.status, 200)
    const seeded = await fetch(`${base}/session/ses_latest/message?limit=80&${client}`)
    assert.equal(seeded.status, 200)
    const stall = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall-html?ids=ses_prev&enabled=true`)
    assert.equal(stall.res.status, 200)
    const failed = await fetch(`${base}/${encodeDir(directory)}/session/ses_prev?${client}`)
    assert.equal(failed.status, 504)
    const progress = await getJson(`${base}/__oc/progress?${client}`)
    assert.equal(progress.res.status, 200)
    assert.equal(progress.data.viewHead.sessionID, "ses_latest")
    assert.equal(progress.data.remoteHead.sessionID, "ses_latest")
    const latest = await fetch(`${base}/session/ses_latest/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`)
    const prev = await fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`)
    assert.equal(latest.headers.get("x-oc-relay-priority"), "foreground")
    assert.equal(prev.headers.get("x-oc-relay-priority"), "background")
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200 }, async () => {
    const client = withClient("client_terminal1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const before = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(before.res.status, 200)
    const ws = await openSocket(`/pty/pty_sandbox/connect?${client}`)
    await sleep(100)
    const healthActive = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(healthActive.res.status, 200)
    assert.equal(healthActive.data.states[0].targetType, "attach-only")
    assert.equal(healthActive.data.states[0].ptyActive, 1)
    assert.equal(healthActive.data.states[0].backgroundWarmPaused, true)
    await sleep(150)
    const resumed = await getJson(`${base}/__oc/meta?${client}`)
    assert.equal(resumed.res.status, 200)
    await sleep(200)
    const after = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    assert.equal(after.res.status, 200)
    assert.equal(after.data.detail, before.data.detail)
    assert.equal(after.data.message, before.data.message)
    const list = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${target}`)
    assert.equal(list.status, 200)
    const healthQueued = await getJson(`${base}/__oc/healthz?${target}`)
    assert.equal(healthQueued.res.status, 200)
    assert.equal(healthQueued.data.states[0].backgroundWarmPaused, true)
    ws.destroy()
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200 }, async () => {
    const client = withClient("client_watch1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const first = await fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`)
    const firstText = await first.text()
    assert.equal(first.status, 200)
    assert(firstText.includes("ses_prev_msg_3"))
    const bumped = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_prev&count=1`)
    assert.equal(bumped.res.status, 200)
    for (let i = 0; i < 20; i++) {
      const next = await fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`)
      const nextText = await next.text()
      if (nextText.includes("ses_prev_msg_4")) {
        assert.equal(next.headers.get("x-oc-cache"), "hit")
        return
      }
      await sleep(150)
    }
    assert.fail("watcher did not refresh cached session messages")
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200 }, async () => {
    const client = withClient("client_sse1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const sse = await connectSse(`${base}/__oc/events?${client}`)
    assert.equal(sse.res.status, 200)
    const bumped = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_prev&count=1`)
    assert.equal(bumped.res.status, 200)
    const payload = await sse.waitFor("message-appended")
    assert(payload.includes("ses_prev"))
    await sse.close()
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200 }, async () => {
    const client = withClient("client_sync1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const sse = await connectSse(`${base}/__oc/events?${client}`)
    const unrelated = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_prev&count=1`)
    assert.equal(unrelated.res.status, 200)
    await sleep(250)
    const before = await getJson(`${base}/__oc/progress?${client}`)
    assert.equal(before.res.status, 200)
    assert.equal(before.data.syncState, "live")
    assert.equal(before.data.admission, "enter")
    const bumped = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_latest&count=1`)
    assert.equal(bumped.res.status, 200)
    const payload = await sse.waitFor("sync-stale")
    assert(payload.includes("head-advanced"))
    for (let i = 0; i < 20; i++) {
      const progress = await getJson(`${base}/__oc/progress?${client}`)
      if (progress.data.syncState === "stale") {
        assert.equal(progress.data.staleReason, "head-advanced")
        assert.equal(progress.data.lastAction, "soft-refresh")
        await sse.close()
        return
      }
      await sleep(150)
    }
    await sse.close()
    assert.fail("sync-stale did not mark the active session stale")
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200, htmlTimeoutMs: 300 }, async () => {
    const client = withClient("client_reenter1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const bumped = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_latest&count=1`)
    assert.equal(bumped.res.status, 200)
    for (let i = 0; i < 20; i++) {
      const progress = await getJson(`${base}/__oc/progress?${client}`)
      if (progress.data.lastAction === "soft-refresh") break
      await sleep(150)
    }
    const stalled = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall-html?ids=ses_latest&enabled=true`)
    assert.equal(stalled.res.status, 200)
    const first = await fetch(`${base}/${encodeDir(directory)}/session/ses_latest?${client}`)
    assert.equal(first.status, 504)
    const second = await fetch(`${base}/${encodeDir(directory)}/session/ses_latest?${client}`)
    assert.equal(second.status, 504)
    const final = await getJson(`${base}/__oc/progress?${client}`)
    assert.equal(final.res.status, 200)
    assert.equal(final.data.lastAction, "re-enter")
    assert.equal(final.data.launch.sessionID, "ses_latest")
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200, htmlTimeoutMs: 300 }, async () => {
    const client = withClient("client_reenter_prev1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const shell = await fetch(`${base}/${encodeDir(directory)}/session/ses_prev?${client}`)
    assert.equal(shell.status, 200)
    const seeded = await fetch(`${base}/session/ses_prev/message?limit=80&${client}`)
    assert.equal(seeded.status, 200)
    const bumped = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/append-message?session=ses_prev&count=1`)
    assert.equal(bumped.res.status, 200)
    for (let i = 0; i < 20; i++) {
      const progress = await getJson(`${base}/__oc/progress?${client}`)
      if (progress.data.lastAction === "soft-refresh") break
      await sleep(150)
    }
    const stalled = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/stall-html?ids=ses_prev&enabled=true`)
    assert.equal(stalled.res.status, 200)
    const first = await fetch(`${base}/${encodeDir(directory)}/session/ses_prev?${client}`)
    assert.equal(first.status, 504)
    const second = await fetch(`${base}/${encodeDir(directory)}/session/ses_prev?${client}`)
    assert.equal(second.status, 504)
    const final = await getJson(`${base}/__oc/progress?${client}`)
    assert.equal(final.res.status, 200)
    assert.equal(final.data.lastAction, "re-enter")
    assert.equal(final.data.launch.sessionID, "ses_prev")
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200 }, async () => {
    const client = withClient("client_progress_query_override1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const latest = await getJson(`${base}/__oc/progress?${client}&directory=${encodeURIComponent(directory)}&sessionID=ses_latest`)
    assert.equal(latest.res.status, 200)
    assert.equal(latest.data.launch.sessionID, "ses_latest")
    const override = await getJson(`${base}/__oc/progress?${client}&directory=${encodeURIComponent(directory)}&sessionID=ses_prev`)
    assert.equal(override.res.status, 200)
    assert.equal(override.data.launch.sessionID, "ses_prev")
    assert.equal(override.data.launch.directory, encodeDir(directory))
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200 }, async () => {
    const client = withClient("client_nonlatest_baseline1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const shell = await fetch(`${base}/${encodeDir(directory)}/session/ses_prev?${client}`)
    assert.equal(shell.status, 200)
    for (let i = 0; i < 20; i++) {
      const progress = await getJson(`${base}/__oc/progress?${client}`)
      assert.equal(progress.res.status, 200)
      assert.notEqual(progress.data.syncState, "stale")
      assert.notEqual(progress.data.lastAction, "soft-refresh")
      await sleep(150)
    }
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200 }, async () => {
    const client = withClient("client_offline_recover1")
    await getJson(`${base}/__oc/meta?${client}`)
    await waitBackgroundReady(client)
    const offline = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/offline?enabled=true`)
    assert.equal(offline.res.status, 200)
    for (let i = 0; i < 20; i++) {
      const progress = await getJson(`${base}/__oc/progress?${client}`)
      if (progress.data.syncState === "offline") {
        assert.equal(progress.data.admission, "attach-only-unavailable")
        assert(progress.data.failureCount >= 1)
        assert(progress.data.backoffUntil >= 0)
        break
      }
      await sleep(150)
    }
    const online = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/offline?enabled=false`)
    assert.equal(online.res.status, 200)
    for (let i = 0; i < 20; i++) {
      const progress = await getJson(`${base}/__oc/progress?${client}`)
      if (progress.data.syncState === "live") return
      await sleep(150)
    }
    assert.fail("offline client did not recover to live state")
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200, launcherHosts: "127.0.0.1" }, async () => {
    const client = withClient("client_launcher_type2")
    const progress = await getJson(`${base}/__oc/progress?${client}`)
    assert.equal(progress.res.status, 200)
    assert.equal(progress.data.targetType, "launcher-managed")
    assert(progress.data.admission === "probe" || progress.data.admission === "enter")
    const meta = await getJson(`${base}/__oc/meta?${client}`)
    assert.equal(meta.res.status, 200)
    assert.equal(meta.data.targetType, "launcher-managed")
    assert(meta.data.admission === "probe" || meta.data.admission === "enter")
  })

  await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, watchIntervalMs: 200, launcherHosts: "127.0.0.1" }, async () => {
    const client = withClient("client_launcher_unavailable1")
    const offline = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/offline?enabled=true`)
    assert.equal(offline.res.status, 200)
    const meta = await getJson(`${base}/__oc/meta?${client}`)
    assert.equal(meta.res.status, 200)
    assert.equal(meta.data.targetType, "launcher-managed")
    assert.equal(meta.data.admission, "launcher-managed-unavailable")
    assert.equal(meta.data.ready, false)
    assert(meta.data.failureReason)
  })

  const cacheDir = makeCacheDir()
  try {
    await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, cacheDir, watchIntervalMs: 200 }, async () => {
      const client = withClient("client_disk1")
      await getJson(`${base}/__oc/meta?${client}`)
      await waitBackgroundReady(client)
      const cached = await fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${client}`)
      const text = await cached.text()
      assert.equal(cached.status, 200)
      assert.equal(cached.headers.get("x-oc-cache"), "hit")
      assert(text.includes("ses_prev_msg_3"))
      const offline = await getJson(`http://127.0.0.1:${upstreamPort}/__debug/offline?enabled=true`)
      assert.equal(offline.res.status, 200)
    })

    await withServers({ metaCacheMs: 100, snapshotCacheMs: 100, cacheDir, watchIntervalMs: 200 }, async () => {
      const cachedMeta = await getJson(`${base}/__oc/meta?${target}`)
      assert.equal(cachedMeta.res.status, 200)
      assert.equal(cachedMeta.data.cache.source, "disk")
      const cached = await fetch(`${base}/session/ses_prev/message?limit=200&directory=${encodeURIComponent(directory)}&${target}`)
      const text = await cached.text()
      assert.equal(cached.status, 200)
      assert.equal(cached.headers.get("x-oc-cache"), "hit")
      assert.equal(cached.headers.get("x-oc-offline"), "true")
      assert(text.includes("ses_prev_msg_3"))
    })
  } finally {
    cleanupDir(cacheDir)
  }

  console.log("sandbox checks passed")
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
