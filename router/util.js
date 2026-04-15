"use strict"

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
}

function validIp(value) {
  const parts = value.split(".")
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!part) return false
    if (!part.split("").every((char) => char >= "0" && char <= "9")) return false
    const num = Number(part)
    return Number.isInteger(num) && num >= 0 && num <= 255
  })
}

function validPort(value) {
  return /^\d{1,5}$/.test(value) && Number(value) > 0 && Number(value) < 65536
}

function validClient(value) {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(String(value || ""))
}

function createClientID() {
  return `c_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`
}

function parseCookies(raw) {
  return (raw || "").split(/;\s*/).reduce((out, item) => {
    const i = item.indexOf("=")
    if (i === -1) return out
    out[item.slice(0, i)] = item.slice(i + 1)
    return out
  }, {})
}

function encodeDir(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function decodeDir(value) {
  try {
    const padded = String(value || "").replace(/-/g, "+").replace(/_/g, "/")
    return Buffer.from(padded + "=".repeat((4 - (padded.length % 4 || 4)) % 4), "base64").toString("utf8")
  } catch {
    return ""
  }
}

function parseTarget(host, port) {
  if (!host) return
  if (!validIp(host)) return
  const nextPort = String(port || "3000")
  if (!validPort(nextPort)) return
  return { host, port: nextPort }
}

function keyFor(target) {
  return `${target.host}:${target.port}`
}

function targetType(target, config) {
  const hosts = config?.launcherHosts || []
  return hosts.includes(target.host) ? "launcher-managed" : "attach-only"
}

function now() {
  return Date.now()
}

function fresh(at, ttl) {
  return Boolean(at && now() - at < ttl)
}

function cacheKey(directory, sessionID, limit) {
  return `${directory}\n${sessionID}\n${limit}`
}

function latest(items) {
  return [...items].sort((a, b) => (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0))[0]
}

function dirKey(value) {
  return String(value || '').replace(/\\+/g, '\\').toLowerCase()
}

function uniqueDirectories(items, maxProjects) {
  const seen = new Set()
  return items
    .map((item) => item?.directory)
    .filter((dir) => {
      const key = dirKey(dir)
      if (!dir || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, maxProjects)
}

function classifyError(err, fallback) {
  const text = err instanceof Error ? err.message : String(err)
  return text || fallback
}

function isMobile(headers) {
  const ua = String(headers["user-agent"] || "")
  return /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(ua)
}

function cleanSearch(input) {
  const next = new URLSearchParams(input)
  next.delete("host")
  next.delete("port")
  next.delete("client")
  const text = next.toString()
  return text ? `?${text}` : ""
}

function isSessionHtmlPath(pathname) {
  return /^\/[^/]+\/session\/[^/]+$/.test(pathname)
}

function isHeavyRequest(reqUrl) {
  if (reqUrl.pathname === "/session/status") return false
  if (reqUrl.pathname === "/session") {
    if (reqUrl.searchParams.get("roots") === "true") return false
    return true
  }
  return /^\/session\/[^/]+\/message$/.test(reqUrl.pathname)
}

function messageRequestInfo(reqUrl) {
  const match = reqUrl.pathname.match(/^\/session\/([^/]+)\/message$/)
  if (!match) return null
  return {
    sessionID: decodeURIComponent(match[1]),
    limit: Number(reqUrl.searchParams.get("limit") || "0"),
  }
}

function bootstrapKey(pathname, directory) {
  return `${pathname}\n${directory || ""}`
}

module.exports = {
  escapeHtml,
  validIp,
  validPort,
  validClient,
  createClientID,
  parseCookies,
  encodeDir,
  decodeDir,
  parseTarget,
  keyFor,
  targetType,
  now,
  fresh,
  cacheKey,
  latest,
  dirKey,
  uniqueDirectories,
  classifyError,
  isMobile,
  cleanSearch,
  isSessionHtmlPath,
  isHeavyRequest,
  messageRequestInfo,
  bootstrapKey,
}
