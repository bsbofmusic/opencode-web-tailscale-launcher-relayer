"use strict"

function env(name, fallback) {
  const value = process.env[name]
  return value == null || value === "" ? fallback : String(value)
}

function safeSegment(value, fallback) {
  const text = String(value || "").trim()
  if (!text) return fallback
  return text.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

const versionInfo = {
  releaseId: env("OPENCODE_ROUTER_RELEASE_ID", "v0.2.4"),
  contractVersion: env("OPENCODE_ROUTER_CONTRACT_VERSION", "2026-04-17.cli-grade"),
  manifestHash: env("OPENCODE_ROUTER_MANIFEST_HASH", "dev-manifest"),
  cacheSchema: env("OPENCODE_ROUTER_CACHE_SCHEMA", "v0.2.4"),
}

function runtimeHeaders(extra) {
  return {
    "X-Relayer-Release": versionInfo.releaseId,
    "X-Relayer-Contract": versionInfo.contractVersion,
    "X-Relayer-Manifest": versionInfo.manifestHash,
    ...(extra || {}),
  }
}

function cachePartition(config) {
  const releaseId = safeSegment(config?.releaseId || versionInfo.releaseId, "unknown-release")
  const contractVersion = safeSegment(config?.contractVersion || versionInfo.contractVersion, "unknown-contract")
  const cacheSchema = safeSegment(config?.cacheSchema || versionInfo.cacheSchema, "unknown-schema")
  return { releaseId, contractVersion, cacheSchema }
}

module.exports = {
  versionInfo,
  runtimeHeaders,
  cachePartition,
}
