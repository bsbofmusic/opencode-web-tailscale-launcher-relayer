"use strict"

const cp = require("child_process")
const http = require("http")
const https = require("https")

function env(name, fallback) {
  const value = process.env[name]
  return value == null || value === "" ? fallback : value
}

function flag(name, fallback) {
  const value = process.env[name]
  if (value == null || value === "") return fallback
  return !["0", "false", "False", "FALSE", "off", "OFF"].includes(String(value))
}

function hasLiveEnv() {
  return Boolean(env("TAILNET_LAUNCH_URL", "") || (env("TAILNET_ROUTER_URL", "") && env("TAILNET_TARGET_HOST", "")))
}

function request(url) {
  return new Promise((resolve) => {
    const target = new URL(url)
    const mod = target.protocol === "https:" ? https : http
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: "GET",
    }, (res) => {
      res.on("data", () => {})
      res.on("end", resolve)
    })
    req.on("error", resolve)
    req.end()
  })
}

function buildMetaUrl() {
  const explicit = env("TAILNET_META_URL", "")
  if (explicit) return explicit
  const launch = env("TAILNET_LAUNCH_URL", "")
  if (launch) {
    const url = new URL("/__oc/meta", launch)
    if (!url.searchParams.get("host") && env("TAILNET_TARGET_HOST", "")) url.searchParams.set("host", env("TAILNET_TARGET_HOST", ""))
    if (!url.searchParams.get("port")) url.searchParams.set("port", env("TAILNET_TARGET_PORT", "3000"))
    return url.toString()
  }
  const router = env("TAILNET_ROUTER_URL", "")
  const host = env("TAILNET_TARGET_HOST", "")
  if (!router || !host) return ""
  const url = new URL("/__oc/meta", router)
  url.searchParams.set("host", host)
  url.searchParams.set("port", env("TAILNET_TARGET_PORT", "3000"))
  return url.toString()
}

function runCheck(check) {
  console.log(`=== ${check.name} ===`)
  cp.execSync(check.cmd, { stdio: "inherit", env: { ...process.env, ...(check.env || {}) } })
}

async function main() {
  const checks = []
  if (flag("TAILNET_RUN_SANDBOX", true)) {
    checks.push({ name: "sandbox-regression", cmd: "node router-sandbox-check.js" })
    checks.push({ name: "root-restore-gate", cmd: "node verify-root-restore-gate.js" })
    checks.push({ name: "stress-gate", cmd: "node verify-stress-gate.js" })
  }
  if (flag("TAILNET_RUN_LIVE", hasLiveEnv())) {
    const metaUrl = buildMetaUrl()
    if (metaUrl) {
      await request(metaUrl)
      await new Promise((resolve) => setTimeout(resolve, Number(env("TAILNET_PREWARM_WAIT_MS", "2000"))))
    }
    if (flag("TAILNET_RUN_BROWSER_SMOKE", false)) {
      checks.push({ name: "browser-smoke", cmd: "node verify-v0.1.6.js" })
    }
    checks.push({ name: "fresh-browser", cmd: "node verify-fresh-browser-gate.js" })
    checks.push({ name: "launch-gate", cmd: "node verify-launch-gate.js" })
  }

  if (!checks.length) {
    throw new Error("No gates enabled. Set TAILNET_RUN_SANDBOX=1 and/or provide live env for TAILNET_RUN_LIVE=1")
  }

  for (const check of checks) runCheck(check)
  console.log("all stable gates passed")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
