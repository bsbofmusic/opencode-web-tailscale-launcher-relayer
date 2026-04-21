"use strict"

const fs = require("fs")
const path = require("path")
const http = require("http")
const https = require("https")
const { execFileSync } = require("child_process")

function env(name, fallback) {
  const value = process.env[name]
  return value == null || value === "" ? fallback : value
}

function loadPlaywright() {
  const explicit = env("PLAYWRIGHT_NODE_PATH", "")
  if (explicit) return require(explicit)
  try {
    return require("playwright")
  } catch {}
  const appDataRoot = process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "playwright") : ""
  if (appDataRoot && fs.existsSync(appDataRoot)) return require(appDataRoot)
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm"
  const globalRoot = execFileSync(npmBin, ["root", "-g"], { encoding: "utf8" }).trim()
  return require(path.join(globalRoot, "playwright"))
}

function encodeDir(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function request(url, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const mod = target.protocol === "https:" ? https : http
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }))
    })
    req.setTimeout(30000, () => req.destroy(new Error("request-timeout")))
    req.on("error", reject)
    if (body) req.write(body)
    req.end()
  })
}

function buildBase() {
  const explicit = env("TAILNET_ROUTER_URL", "")
  if (!explicit) throw new Error("Set TAILNET_ROUTER_URL")
  return explicit.replace(/\/$/, "")
}

async function main() {
  const { chromium } = loadPlaywright()
  const base = buildBase()
  const host = env("TAILNET_TARGET_HOST", "")
  const port = env("TAILNET_TARGET_PORT", "3000")
  const directory = env("TAILNET_DIRECTORY", "D:\\CODE\\opencode-tailscale")
  if (!host) throw new Error("Set TAILNET_TARGET_HOST")

  const create = await request(
    `${base}/session?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&directory=${encodeURIComponent(directory)}`,
    "POST",
    JSON.stringify({ title: `source-boundary-${Date.now()}` }),
    { "content-type": "application/json" },
  )
  if (create.status >= 400) throw new Error(`create-session-failed ${create.status} ${create.body}`)
  const created = JSON.parse(create.body)
  const sessionID = created.id
  if (!sessionID) throw new Error("create-session-missing-id")

  const browser = await chromium.launch({ headless: env("TAILNET_HEADLESS", "1") !== "0" })
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded", timeout: 30000 })
    await page.evaluate(() => {
    localStorage.setItem("opencode.global.dat:server", JSON.stringify({
      projects: {
        [location.origin]: [
          { id: "desktop-fake", worktree: "C:\\Users\\Fake\\Desktop", sandboxes: [] },
          { id: "relay:FAKE", worktree: "E:\\FAKE", sandboxes: [] },
        ],
      },
      lastProject: { [location.origin]: "C:\\Users\\Fake\\Desktop" },
    }))
    localStorage.setItem("opencode.global.dat:globalSync.project", JSON.stringify({
      value: [
        { id: "desktop-fake", worktree: "C:\\Users\\Fake\\Desktop", sandboxes: [] },
        { id: "relay:FAKE", worktree: "E:\\FAKE", sandboxes: [] },
      ],
    }))
    localStorage.setItem("opencode.settings.dat:defaultServerUrl", "http://desktop-invalid")
    })

    const client = `c_boundary_${Date.now().toString(36)}`
    const launchUrl = `${base}/__oc/launch?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&directory=${encodeURIComponent(directory)}&sessionID=${encodeURIComponent(sessionID)}&client=${encodeURIComponent(client)}`
    const sessionUrl = `${base}/${encodeDir(directory)}/session/${encodeURIComponent(sessionID)}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&client=${encodeURIComponent(client)}`
    await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: 30000 })
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (page.url() === sessionUrl) break
      await page.waitForTimeout(500)
    }
    if (page.url() !== sessionUrl) throw new Error(`launch-did-not-enter-session ${page.url()}`)
    await page.waitForTimeout(3000)
    const state = await page.evaluate(() => {
    const parse = (key) => {
      try { return JSON.parse(localStorage.getItem(key) || "null") } catch { return null }
    }
    return {
      origin: location.origin,
      serverKey: (location.hostname === '127.0.0.1' || location.hostname === 'localhost') ? 'local' : location.origin,
      server: parse("opencode.global.dat:server"),
      globalProject: parse("opencode.global.dat:globalSync.project"),
      defaultServer: localStorage.getItem("opencode.settings.dat:defaultServerUrl"),
    }
    })

    const projects = (((state.server || {}).projects || {})[state.serverKey] || [])
    const globalValue = (((state.globalProject || {}).value) || [])
    const badProject = projects.find((item) => item?.id === "desktop-fake" || String(item?.id || "").startsWith("relay:"))
    const badGlobal = globalValue.find((item) => item?.id === "desktop-fake" || String(item?.id || "").startsWith("relay:"))
    const ok = projects.length > 0 && !badProject && !badGlobal && state.defaultServer === state.origin
    console.log(JSON.stringify({ sessionID, origin: state.origin, serverKey: state.serverKey, projects, globalValue, defaultServer: state.defaultServer, ok }, null, 2))
    if (!ok) process.exitCode = 1
  } finally {
    try { await browser.close() } catch {}
    try {
      await request(
        `${base}/session/${encodeURIComponent(sessionID)}?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&directory=${encodeURIComponent(directory)}`,
        "DELETE",
      )
    } catch {}
  }
  if (process.exitCode) process.exit(process.exitCode)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
