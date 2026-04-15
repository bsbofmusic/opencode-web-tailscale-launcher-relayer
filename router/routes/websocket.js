"use strict"

const http = require("http")
const { cleanSearch } = require("../util")
const { drainHeavy, pumpBackground } = require("../heavy")
const { getAgent } = require("../warm")

function writeUpgradeResponse(socket, response) {
  const lines = [`HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || "Switching Protocols"}`]
  for (const [key, value] of Object.entries(response.headers || {})) {
    if (Array.isArray(value)) value.forEach((item) => lines.push(`${key}: ${item}`))
    else if (value !== undefined) lines.push(`${key}: ${value}`)
  }
  lines.push("", "")
  socket.write(lines.join("\r\n"))
}

function proxyUpgrade(req, socket, head, target, reqUrl, state, config) {
  const terminal = /^\/pty\/[^/]+\/connect$/.test(reqUrl.pathname)
  if (terminal) state.ptyActive += 1
  let closed = false
  const maxHeavy = (config && config.maxHeavyRequestsPerTarget) || 2
  const maxBg = Math.max(1, maxHeavy - 1)
  const cleanup = () => {
    if (closed) return
    closed = true
    if (!terminal) return
    state.ptyActive = Math.max(0, state.ptyActive - 1)
    drainHeavy(state, maxHeavy, maxBg)
    pumpBackground(state)
  }
  const upstream = http.request({
    hostname: target.host,
    port: Number(target.port),
    method: req.method,
    path: `${reqUrl.pathname}${cleanSearch(reqUrl.searchParams)}`,
    headers: { ...req.headers, host: `${target.host}:${target.port}`, connection: "upgrade" },
    agent: getAgent(),
  })
  if (terminal) {
    socket.on("close", () => { cleanup(); if (!upstream.destroyed) upstream.destroy() })
    socket.on("error", () => { cleanup(); if (!upstream.destroyed) upstream.destroy() })
  }
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    writeUpgradeResponse(socket, upRes)
    if (head && head.length) upSocket.write(head)
    if (upHead && upHead.length) socket.write(upHead)
    upSocket.on("close", cleanup)
    socket.on("close", cleanup)
    upSocket.on("error", cleanup)
    socket.on("error", cleanup)
    upSocket.pipe(socket)
    socket.pipe(upSocket)
  })
  upstream.on("response", () => { cleanup(); socket.destroy() })
  upstream.on("error", () => { cleanup(); socket.destroy() })
  upstream.end()
}

module.exports = { proxyUpgrade, writeUpgradeResponse }
