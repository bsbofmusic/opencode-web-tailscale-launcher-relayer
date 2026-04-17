"use strict"

const fs = require("fs")
const path = require("path")
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

function buildLaunchUrl() {
  const explicit = env("TAILNET_LAUNCH_URL", "")
  if (explicit) return explicit
  const router = env("TAILNET_ROUTER_URL", "")
  const host = env("TAILNET_TARGET_HOST", "")
  const port = env("TAILNET_TARGET_PORT", "3000")
  if (!router || !host) throw new Error("Set TAILNET_LAUNCH_URL or TAILNET_ROUTER_URL + TAILNET_TARGET_HOST")
  const url = new URL("/__oc/launch", router)
  url.searchParams.set("host", host)
  url.searchParams.set("port", port)
  return url.toString()
}

const { chromium } = loadPlaywright()
const LAUNCH_URL = buildLaunchUrl()

async function runTests() {
  const browser = await chromium.launch({ headless: true })
  let passed = 0
  let failed = 0

  async function test(name, fn) {
    const context = await browser.newContext()
    const page = await context.newPage()
    try {
      await fn(page, context)
      console.log(`  PASS  ${name}`)
      passed++
    } catch (e) {
      console.log(`  FAIL  ${name}: ${e.message}`)
      failed++
    } finally {
      await context.close()
    }
  }

  async function waitForSessionRoute(page) {
    await page.waitForURL(/\/session\//, { timeout: 60000 })
  }

  // Test 1: cold launch lands on session page
  await test("cold-launch-lands-on-session", async (page) => {
    await page.goto(LAUNCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
    await waitForSessionRoute(page)
    const finalUrl = page.url()
    if (!finalUrl.includes("/session/")) throw new Error(`Expected /session/ in URL, got: ${finalUrl}`)
    console.log(`    URL: ${finalUrl}`)
  })

  // Test 2: URL stable after 5 seconds (faster check)
  await test("url-stable-after-5s", async (page) => {
    await page.goto(LAUNCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
    await waitForSessionRoute(page)
    const sessionUrl = page.url()
    await page.waitForTimeout(5000)
    const finalUrl = page.url()
    if (finalUrl !== sessionUrl) throw new Error(`URL changed: ${sessionUrl} -> ${finalUrl}`)
    console.log(`    Stable at: ${finalUrl}`)
  })

  // Test 3: no console errors during launch
  await test("no-console-errors-on-launch", async (page) => {
    const consoleErrors = []
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })
    await page.goto(LAUNCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
    await waitForSessionRoute(page)
    await page.waitForTimeout(3000)
    const relevant = consoleErrors.filter(e => !e.includes("favicon") && !e.includes("ERR_BLOCKED"))
    if (relevant.length > 0) throw new Error(`Console errors: ${relevant.join("; ")}`)
  })

  // Test 4: relay meta endpoint returns ready=true
  await test("relay-meta-ready", async (page) => {
    const url = new URL("/__oc/meta", LAUNCH_URL)
    url.searchParams.set("host", env("TAILNET_TARGET_HOST", url.searchParams.get("host") || ""))
    url.searchParams.set("port", env("TAILNET_TARGET_PORT", url.searchParams.get("port") || "3000"))
    const res = await page.goto(url.toString(), { timeout: 10000 })
    if (res.status() !== 200) throw new Error(`Expected 200, got ${res.status()}`)
    const data = await page.evaluate(() => JSON.parse(document.body.textContent))
    if (!data.ready) throw new Error(`Expected ready=true, got ready=${data.ready}`)
    if (!data.cache) throw new Error("Expected cache object in meta")
    console.log(`    ready=${data.ready}, cache.stale=${data.cache?.stale}, cache.warm=${data.cache?.warm}`)
  })

  // Test 5: relay progress endpoint works
  await test("relay-progress-endpoint", async (page) => {
    // First get a client ID from the launch
    await page.goto(LAUNCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 })
    await waitForSessionRoute(page)
    const client = page.url().match(/client=([^&]+)/)?.[1]
    if (!client) throw new Error("No client ID in URL")
    const progressUrl = new URL("/__oc/progress", LAUNCH_URL)
    progressUrl.searchParams.set("host", env("TAILNET_TARGET_HOST", progressUrl.searchParams.get("host") || ""))
    progressUrl.searchParams.set("port", env("TAILNET_TARGET_PORT", progressUrl.searchParams.get("port") || "3000"))
    progressUrl.searchParams.set("client", client)
    const res = await page.goto(progressUrl.toString(), { timeout: 10000 })
    if (res.status() !== 200) throw new Error(`Expected 200, got ${res.status()}`)
    const data = await page.evaluate(() => JSON.parse(document.body.textContent))
    console.log(`    syncState=${data.syncState}, lastAction=${data.lastAction}`)
  })

  await browser.close()
  console.log(`\nResults: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch((e) => {
  console.error("Test runner error:", e)
  process.exit(1)
})
