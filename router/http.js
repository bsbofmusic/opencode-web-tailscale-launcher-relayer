"use strict"

function relayHeaders(priority, mode, reason, cache) {
  const headers = {
    "X-OC-Relay-Priority": priority,
    "X-OC-Relay-Mode": mode,
    "X-OC-Relay-Reason": reason,
  }
  if (cache) headers["X-OC-Cache"] = cache
  return headers
}

function withRelay(headers, priority, mode, reason, cache) {
  return { ...(headers || {}), ...relayHeaders(priority, mode, reason, cache) }
}

function json(res, code, body, extra) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(extra || {}),
  })
  res.end(JSON.stringify(body))
}

function raw(res, code, body, type, extra) {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    ...(extra || {}),
  })
  res.end(body)
}

function text(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "public, max-age=86400",
  })
  res.end(body)
}

module.exports = { relayHeaders, withRelay, json, raw, text }
