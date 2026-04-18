"use strict"

const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { spawn } = require("child_process")

const routerPort = Number(process.env.STRESS_ROUTER_PORT || "33123")
const upstreamPort = Number(process.env.STRESS_UPSTREAM_PORT || "3423")
const base = `http://127.0.0.1:${routerPort}`
const target = `host=127.0.0.1&port=${upstreamPort}`
const directory = process.env.SANDBOX_DIRECTORY || "D:\\CODE"
const cwd = __dirname
const cacheRootBase = path.join(cwd, ".tmp-router-cache-tests")

function envNumber(name, fallback) {
  const value = Number(process.env[name] || String(fallback))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function encodeDir(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

async function getJson(url, init) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000), ...(init || {}) })
  const text = await res.text()
  return { res, data: text ? JSON.parse(text) : {} }
}

async function waitForReady(url, attempts = 20, delayMs = 500) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    last = await getJson(url)
    if (last.res.status === 200 && last.data?.ok === true) return last
    await sleep(delayMs)
  }
  return last
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

async function waitFor(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (res.ok) return
    } catch {}
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function makeCacheDir() {
  fs.mkdirSync(cacheRootBase, { recursive: true })
  return fs.mkdtempSync(path.join(cacheRootBase, "stress-"))
}

function cleanupDir(dir) {
  if (!dir) return
  fs.rmSync(dir, { recursive: true, force: true })
}

async function withServers(fn) {
  const cacheDir = makeCacheDir()
  const up = startNode("router-sandbox-upstream.js", {
    SANDBOX_UPSTREAM_PORT: String(upstreamPort),
    SANDBOX_DIRECTORY: directory,
    SANDBOX_SESSION_COUNT: String(envNumber("STRESS_SESSION_COUNT", 40)),
  })
  const rt = startNode("vps-opencode-router.js", {
    OPENCODE_ROUTER_PORT: String(routerPort),
    OPENCODE_ROUTER_CACHE_DIR: cacheDir,
    OPENCODE_ROUTER_WATCH_INTERVAL_MS: String(envNumber("STRESS_WATCH_INTERVAL_MS", 200)),
    OPENCODE_ROUTER_META_CACHE_MS: String(envNumber("STRESS_META_CACHE_MS", 200)),
    OPENCODE_ROUTER_SNAPSHOT_CACHE_MS: String(envNumber("STRESS_SNAPSHOT_CACHE_MS", 200)),
    OPENCODE_ROUTER_BACKGROUND_SOFT_LIMIT: String(envNumber("STRESS_BACKGROUND_SOFT_LIMIT", 10)),
    OPENCODE_ROUTER_MAX_BACKGROUND_QUEUE: String(envNumber("STRESS_MAX_BACKGROUND_QUEUE", 16)),
    OPENCODE_ROUTER_WATCHDOG_OVERLOAD_MS: String(envNumber("STRESS_WATCHDOG_OVERLOAD_MS", 4000)),
    OPENCODE_ROUTER_RELEASE_ID: process.env.OPENCODE_ROUTER_RELEASE_ID || "v0.2.4",
  })
  try {
    await waitFor(`http://127.0.0.1:${upstreamPort}/__debug/counts`)
    await waitFor(`${base}/`)
    return await fn()
  } finally {
    rt.kill()
    up.kill()
    cleanupDir(cacheDir)
  }
}

async function warmReady() {
  const client = `client_stress_${Date.now().toString(36)}`
  await getJson(`${base}/__oc/meta?${target}&client=${client}`)
  for (let i = 0; i < 120; i++) {
    const progress = await getJson(`${base}/__oc/progress?${target}&client=${client}`)
    if (progress.data.ready && progress.data.refreshing === false) return client
    await sleep(100)
  }
  throw new Error("Timed out warming baseline state before stress")
}

async function runFetch(url) {
  const startedAt = Date.now()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const text = await res.text()
    return { ok: res.ok, status: res.status, durationMs: Date.now() - startedAt, text }
  } catch (err) {
    return { ok: false, status: 0, durationMs: Date.now() - startedAt, error: String(err?.message || err || "unknown") }
  }
}

function percentile(values, p) {
  if (!values.length) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

async function main() {
  await withServers(async () => {
    const client = await warmReady()
    const dirToken = encodeDir(directory)
    const rounds = envNumber("STRESS_ROUNDS", 6)
    const openConcurrency = envNumber("STRESS_OPEN_CONCURRENCY", 12)
    const messageConcurrency = envNumber("STRESS_MESSAGE_CONCURRENCY", 12)
    const sessionConcurrency = envNumber("STRESS_SESSION_CONCURRENCY", 8)
    const progressConcurrency = envNumber("STRESS_PROGRESS_CONCURRENCY", 8)

    const urls = []
    for (let i = 0; i < rounds; i++) {
      for (let j = 0; j < openConcurrency; j++) urls.push(`${base}/${dirToken}/session/ses_latest?${target}&client=${client}`)
      for (let j = 0; j < messageConcurrency; j++) urls.push(`${base}/session/ses_latest/message?limit=80&directory=${encodeURIComponent(directory)}&${target}&client=${client}`)
      for (let j = 0; j < sessionConcurrency; j++) urls.push(`${base}/session?directory=${encodeURIComponent(directory)}&roots=true&limit=55&${target}&client=${client}`)
      for (let j = 0; j < progressConcurrency; j++) urls.push(`${base}/__oc/progress?${target}&client=${client}`)
    }

    const results = await Promise.all(urls.map((url) => runFetch(url)))
    const failures = results.filter((item) => !item.ok)
    const durations = results.map((item) => item.durationMs)
    const health = await getJson(`${base}/__oc/healthz?${target}`)
    const livez = await getJson(`${base}/__oc/livez`)
    const readyz = await waitForReady(`${base}/__oc/readyz`)
    const modez = await getJson(`${base}/__oc/modez`)
    const state = health.data.states[0]

    assert.equal(livez.res.status, 200)
    assert.equal(livez.data.release.releaseId, process.env.OPENCODE_ROUTER_RELEASE_ID || "v0.2.4")
    assert.equal(readyz.res.status, 200)
    assert.equal(modez.res.status, 200)
    assert.equal(health.res.status, 200)
    assert(state, "missing target health state")
    assert.equal(state.targetStatus, "ready")
    assert.equal(state.lastError, null)
    assert.equal(state.failureReason, null)
    assert(state.backgroundQueued <= envNumber("STRESS_MAX_BACKGROUND_QUEUE", 16), `backgroundQueued too high: ${state.backgroundQueued}`)
    assert(failures.length === 0, `stress failures=${failures.length}`)

    const report = {
      requests: results.length,
      failures: failures.length,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      schedulerMode: state.schedulerMode,
      backgroundQueued: state.backgroundQueued,
      heavyQueued: state.heavyQueued,
      staleClients: state.staleClients,
      release: livez.data.release,
    }
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
