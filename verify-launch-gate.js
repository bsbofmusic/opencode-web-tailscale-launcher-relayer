"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")

function loadPlaywright() {
  const explicit = env("PLAYWRIGHT_NODE_PATH", "")
  if (explicit) {
    return require(explicit)
  }
  try {
    return require("playwright")
  } catch {}
  const appDataRoot = process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules", "playwright") : ""
  if (appDataRoot && fs.existsSync(appDataRoot)) {
    return require(appDataRoot)
  }
  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm"
  const globalRoot = execFileSync(npmBin, ["root", "-g"], { encoding: "utf8" }).trim()
  return require(path.join(globalRoot, "playwright"))
}

function env(name, fallback) {
  const value = process.env[name]
  return value == null || value === "" ? fallback : value
}

function numberEnv(name, fallback) {
  const value = Number(env(name, String(fallback)))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function buildLaunchUrl() {
  const explicit = env("TAILNET_LAUNCH_URL", "")
  if (explicit) return explicit
  const router = env("TAILNET_ROUTER_URL", "")
  const host = env("TAILNET_TARGET_HOST", "")
  const port = env("TAILNET_TARGET_PORT", "3000")
  if (!router || !host) {
    throw new Error("Set TAILNET_LAUNCH_URL or TAILNET_ROUTER_URL + TAILNET_TARGET_HOST")
  }
  const url = new URL("/__oc/launch", router)
  url.searchParams.set("host", host)
  url.searchParams.set("port", port)
  return url.toString()
}

function safeName(value) {
  return String(value || "run").replace(/[^a-zA-Z0-9._-]+/g, "-")
}

function evidenceDir() {
  const explicit = env("TAILNET_EVIDENCE_DIR", "")
  const root = explicit || path.join(os.tmpdir(), "opencode-tailnet-launch-gate")
  fs.mkdirSync(root, { recursive: true })
  return root
}

function profileConfig(name) {
  if (name === "mobile") {
    return {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    }
  }
  return {
    viewport: { width: 1440, height: 900 },
  }
}

function assertProfiles(values) {
  const invalid = values.filter((item) => item !== "desktop" && item !== "mobile")
  if (invalid.length) {
    throw new Error(`Invalid TAILNET_VERIFY_PROFILES entries: ${invalid.join(", ")}. Allowed values: desktop,mobile`)
  }
  if (env("TAILNET_REQUIRE_BOTH_PROFILES", "1") !== "0") {
    const set = new Set(values)
    if (values.length !== 2 || set.size !== 2 || !set.has("desktop") || !set.has("mobile")) {
      throw new Error("Pre-ship gate requires exactly desktop,mobile. Set TAILNET_REQUIRE_BOTH_PROFILES=0 only for local debugging.")
    }
  }
}

function looksLikeSuccess(state, network) {
  if (!/\/session\//i.test(state.url || "")) return false
  const text = `${state.title || ""}\n${state.body || ""}`
  if (/OpenCode Launching|OpenCode session page is taking too long|The VPS could not warm this target|Bad Gateway|502|503|504/i.test(text)) {
    return false
  }
  const sessionOk = network.some((item) => /\/session\//.test(item.url) && item.status >= 200 && item.status < 300)
  if (!sessionOk) return false
  const expectBody = env("TAILNET_EXPECT_BODY_REGEX", "Tailnet live")
  if (expectBody) {
    const re = new RegExp(expectBody, "i")
    if (!re.test(text)) return false
  }
  return String(state.body || "").trim().length > 0
}

function doneReason(state) {
  const body = String(state.body || "")
  if (/401 Unauthorized|403 Forbidden|Basic realm|sign in|log in|login/i.test(`${state.title || ""}\n${body}`)) {
    return { done: true, ok: false, reason: "auth-challenge" }
  }
  if (/502 Bad Gateway/i.test(`${state.title || ""}\n${body}`)) {
    return { done: true, ok: false, reason: "bad-gateway" }
  }
  if (/Attach-only target is not currently serving OpenCode web/i.test(body)) {
    return { done: true, ok: false, reason: "attach-only-unavailable" }
  }
  if (/Launcher-managed target is reachable, but OpenCode is not ready there yet/i.test(body)) {
    return { done: true, ok: false, reason: "launcher-managed-unavailable" }
  }
  if (/OpenCode session page is taking too long/i.test(body) || /Session Timeout/i.test(state.title || "")) {
    return { done: true, ok: false, reason: "timeout-page" }
  }
  if (/Target is online but has no historical sessions/i.test(body)) {
    return { done: true, ok: false, reason: "no-historical-sessions" }
  }
  if (/The VPS could not warm this target/i.test(body)) {
    return { done: true, ok: false, reason: "warm-failed" }
  }
  return { done: false, ok: false, reason: null }
}

function successReason(state, network) {
  const failure = doneReason(state)
  if (failure.done) return failure
  if (looksLikeSuccess(state, network)) {
    return { done: true, ok: true, reason: "session-route" }
  }
  return { done: false, ok: false, reason: null }
}

async function inspectPage(page) {
  for (let i = 0; i < 3; i++) {
    try {
      return await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        stage: document.getElementById("stage")?.textContent || null,
        note: document.getElementById("note")?.textContent || null,
        fill: document.getElementById("fill")?.style.width || null,
        body: (document.body?.innerText || "").slice(0, 1500),
      }))
    } catch (err) {
      const text = String(err && err.message ? err.message : err)
      if (!/Execution context was destroyed|Cannot find context/i.test(text) || i === 2) throw err
      await page.waitForTimeout(100)
    }
  }
}

async function safeInspect(page, last) {
  try {
    return await Promise.race([
      inspectPage(page),
      page.waitForTimeout(2000).then(() => { throw new Error("inspect-timeout") }),
    ])
  } catch {
    return {
      url: page.url(),
      title: last?.title || "",
      stage: last?.stage || null,
      note: last?.note || null,
      fill: last?.fill || null,
      body: last?.body || "",
    }
  }
}

async function runProfile(browserType, launchUrl, profile, outputRoot) {
  const startedAt = Date.now()
  const network = []
  const consoleMessages = []
  const pageErrors = []
  const urls = []
  const browser = await browserType.launch({ headless: env("TAILNET_HEADLESS", "1") !== "0" })
  const context = await browser.newContext(profileConfig(profile))
  const page = await context.newPage()

  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text(), atMs: Date.now() - startedAt })
  })
  page.on("pageerror", (err) => {
    pageErrors.push({ text: String(err && err.message ? err.message : err), atMs: Date.now() - startedAt })
  })
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) urls.push({ url: frame.url(), atMs: Date.now() - startedAt })
  })
  page.on("response", async (res) => {
    const url = res.url()
    if (!/__oc\/progress|__oc\/meta|\/session\//.test(url)) return
    network.push({ url, status: res.status(), atMs: Date.now() - startedAt })
  })

  let gotoError = null
  try {
    console.error(`GOTO ${profile}`)
    await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: numberEnv("TAILNET_NAV_TIMEOUT_MS", 30000) })
    console.error(`GOTO_OK ${profile}`)
  } catch (err) {
    gotoError = String(err && err.message ? err.message : err)
    console.error(`GOTO_ERR ${profile} ${gotoError}`)
  }

  const deadline = Date.now() + numberEnv("TAILNET_GATE_TIMEOUT_MS", 15000)
  let state = await safeInspect(page)
  let reason = successReason(state, network)
  while (!reason.done && Date.now() < deadline) {
    await page.waitForTimeout(numberEnv("TAILNET_POLL_MS", 250))
    state = await safeInspect(page, state)
    reason = successReason(state, network)
  }
  if (!reason.done) {
    const nav = urls.find((item) => /\/session\//i.test(item.url))
    if (nav && network.some((item) => /\/session\//.test(item.url) && item.status >= 200 && item.status < 300)) {
      state = { ...state, url: nav.url, body: state.body || "session-route" }
      reason = { done: true, ok: true, reason: "session-route" }
    } else {
      reason = { done: true, ok: false, reason: finalReason({ reason: "timeout-still-in-launch-gate", network }) }
    }
  }

  const artifactBase = path.join(outputRoot, `${safeName(profile)}-${Date.now()}`)
  const screenshotPath = `${artifactBase}.png`
  const jsonPath = `${artifactBase}.json`
  await Promise.race([
    page.screenshot({ path: screenshotPath, fullPage: false }),
    page.waitForTimeout(5000).then(() => { throw new Error("screenshot-timeout") }),
  ]).catch(() => {})
  const result = {
    profile,
    launchUrl,
    gotoError,
    ok: reason.done && reason.ok,
    reason: reason.reason || "timeout-still-in-launch-gate",
    durationMs: Date.now() - startedAt,
    state,
    urls,
    consoleMessages,
    pageErrors,
    network,
    screenshotPath,
  }
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2))
  result.jsonPath = jsonPath
  console.error(`CLOSE ${profile}`)
  await Promise.race([context.close(), page.waitForTimeout(5000)]).catch(() => {})
  await Promise.race([browser.close(), page.waitForTimeout(5000)]).catch(() => {})
  return result
}

function shouldRetry(result) {
  if (result.ok) return false
  if (result.reason !== "timeout-still-in-launch-gate") return false
  const text = `${result.state?.title || ""}\n${result.state?.stage || ""}\n${result.state?.note || ""}\n${result.state?.body || ""}`
  return /Ready\. Opening the session|prepared the session\. Entering now/i.test(text)
}

function finalReason(result) {
  if (result.reason !== "timeout-still-in-launch-gate") return result.reason
  const progress200 = result.network.filter((item) => /__oc\/progress/.test(item.url) && item.status === 200).length
  if (progress200 >= 3) return "stuck-progress-loop"
  return result.reason
}

async function main() {
  const { chromium } = loadPlaywright()
  const launchUrl = buildLaunchUrl()
  const profiles = env("TAILNET_VERIFY_PROFILES", "desktop,mobile")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  assertProfiles(profiles)
  const out = evidenceDir()
  const results = []
  const kill = setTimeout(() => {
    console.error(JSON.stringify({ error: "overall-timeout", launchUrl, profiles }, null, 2))
    process.exit(124)
  }, numberEnv("TAILNET_OVERALL_TIMEOUT_MS", 120000))

  for (const profile of profiles) {
    console.error(`START ${profile}`)
    let result = await runProfile(chromium, launchUrl, profile, out)
    if (shouldRetry(result)) {
      console.error(`RETRY ${profile}`)
      result = await runProfile(chromium, launchUrl, profile, out)
    }
    result.reason = finalReason(result)
    results.push(result)
    console.error(`DONE ${profile} ${result.reason} ok=${result.ok}`)
  }

  const failed = results.filter((item) => !item.ok)
  process.stdout.write(`${JSON.stringify({ launchUrl, results }, null, 2)}\n`)
  clearTimeout(kill)
  if (failed.length) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
