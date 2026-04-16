"use strict"

const http = require("http")
const { buildContext } = require("./context")
const { dispatch } = require("./dispatch")
const { ensureState, cleanupStates } = require("./state")
const { proxyUpgrade } = require("./routes/websocket")
const { getTarget } = require("./context")

function envFlag(name, fallback) {
  const value = process.env[name]
  if (value === undefined) return fallback
  return !["0", "false", "False", "FALSE", "off", "OFF"].includes(String(value))
}

function createRouter(options) {
  const opts = options || {}
  const bindHost = opts.host || process.env.OPENCODE_ROUTER_HOST || "127.0.0.1"
  const bindPort = Number(opts.port || process.env.OPENCODE_ROUTER_PORT || "33102")

  const config = {
    inspectTimeoutMs: Number(process.env.OPENCODE_ROUTER_INSPECT_TIMEOUT_MS || "8000"),
    warmTimeoutMs: Number(process.env.OPENCODE_ROUTER_WARM_TIMEOUT_MS || String(Number(process.env.OPENCODE_ROUTER_INSPECT_TIMEOUT_MS || "8000") + 7000)),
    htmlProxyTimeoutMs: Number(process.env.OPENCODE_ROUTER_HTML_TIMEOUT_MS || "8000"),
    metaCacheMs: Number(process.env.OPENCODE_ROUTER_META_CACHE_MS || "15000"),
    snapshotCacheMs: Number(process.env.OPENCODE_ROUTER_SNAPSHOT_CACHE_MS || "45000"),
    cacheDir: process.env.OPENCODE_ROUTER_CACHE_DIR || "",
    watchIntervalMs: Number(process.env.OPENCODE_ROUTER_WATCH_INTERVAL_MS || "5000"),
    maxSessions: 80,
    directoryDiscoveryLimit: Number(process.env.OPENCODE_ROUTER_DIRECTORY_DISCOVERY_LIMIT || "120"),
    watcherSessionLimit: Number(process.env.OPENCODE_ROUTER_WATCHER_SESSION_LIMIT || "40"),
    maxProjects: Number(process.env.OPENCODE_ROUTER_MAX_PROJECTS || "64"),
    desktopWarmSessionCount: 2,
    mobileWarmSessionCount: 1,
    maxHeavyRequestsPerTarget: 2,
    maxTargets: 8,
    targetIdleMs: 30 * 60 * 1000,
    cleanupIntervalMs: 5 * 60 * 1000,
    launchRedirectWaitMs: 1200,
    fastLaunchRedirectWaitMs: Number(process.env.OPENCODE_ROUTER_FAST_LAUNCH_WAIT_MS || "250"),
    slowHealthLatencyMs: Number(process.env.OPENCODE_ROUTER_SLOW_HEALTH_MS || "1500"),
    idleRecoveryThresholdMs: Number(process.env.OPENCODE_ROUTER_IDLE_RECOVERY_THRESHOLD_MS || "300000"),
    idleRecoveryWindowMs: Number(process.env.OPENCODE_ROUTER_IDLE_RECOVERY_WINDOW_MS || "30000"),
    recoveryRetryMs: Number(process.env.OPENCODE_ROUTER_RECOVERY_RETRY_MS || "1500"),
    recoveryHtmlTimeoutMs: Number(process.env.OPENCODE_ROUTER_RECOVERY_HTML_TIMEOUT_MS || "15000"),
    backgroundSoftLimit: Number(process.env.OPENCODE_ROUTER_BACKGROUND_SOFT_LIMIT || "12"),
    maxBackgroundQueue: Number(process.env.OPENCODE_ROUTER_MAX_BACKGROUND_QUEUE || "20"),
    backgroundJobTTLMs: Number(process.env.OPENCODE_ROUTER_BACKGROUND_JOB_TTL_MS || "45000"),
    heavyBackgroundSoftLimit: Number(process.env.OPENCODE_ROUTER_HEAVY_BACKGROUND_SOFT_LIMIT || "4"),
    promiseAgeSoftLimitMs: Number(process.env.OPENCODE_ROUTER_PROMISE_AGE_SOFT_LIMIT_MS || "10000"),
    watcherSessionBudget: Number(process.env.OPENCODE_ROUTER_WATCHER_SESSION_BUDGET || "4"),
    watcherSessionBudgetOverload: Number(process.env.OPENCODE_ROUTER_WATCHER_SESSION_BUDGET_OVERLOAD || "1"),
    rootsRefreshTtlMs: Number(process.env.OPENCODE_ROUTER_ROOTS_REFRESH_TTL_MS || "300000"),
    watchdogIntervalMs: Number(process.env.OPENCODE_ROUTER_WATCHDOG_INTERVAL_MS || "15000"),
    watchdogOverloadMs: Number(process.env.OPENCODE_ROUTER_WATCHDOG_OVERLOAD_MS || "60000"),
    assetCacheMs: Number(process.env.OPENCODE_ROUTER_ASSET_CACHE_MS || String(24 * 60 * 60 * 1000)),
    launcherHosts: String(process.env.OPENCODE_ROUTER_LAUNCHER_HOSTS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    extraRoots: String(process.env.OPENCODE_ROUTER_EXTRA_ROOTS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    enableProgressQueryOverride: envFlag("OPENCODE_ROUTER_ENABLE_PROGRESS_QUERY_OVERRIDE", false),
    healthzDebug: envFlag("OPENCODE_ROUTER_HEALTHZ_DEBUG", false),
    ...opts.config,
  }

  const states = new Map()

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const ctx = buildContext(req, reqUrl, states, config)
    dispatch(ctx, req, res, states)
  })

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)
    const target = getTarget(reqUrl, req.headers)
    if (!target) {
      socket.destroy()
      return
    }
    const state = ensureState(states, target, config)
    proxyUpgrade(req, socket, head, target, reqUrl, state, config)
  })

  const cleanupTimer = setInterval(() => {
    cleanupStates(states, false, config)
    const { selfHealStates } = require("./state")
    selfHealStates(states, config)
  }, Math.min(config.cleanupIntervalMs, config.watchdogIntervalMs))
  cleanupTimer.unref?.()

  server.listen(bindPort, bindHost, () => {
    console.log(`OpenCode router listening on http://${bindHost}:${bindPort}`)
  })

  return { server, states, config }
}

if (require.main === module) {
  createRouter()
}

module.exports = { createRouter }
