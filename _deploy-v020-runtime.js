"use strict"

const { Client } = require("ssh2")
const fs = require("fs")
const path = require("path")
const crypto = require("crypto")
const https = require("https")

const HOST = process.env.RELAYER_DEPLOY_HOST || "43.162.103.154"
const USER = process.env.RELAYER_DEPLOY_USER || "ubuntu"
const PASS = process.env.RELAYER_DEPLOY_PASS || "Zz76121819100!"
const REMOTE_DIR = process.env.RELAYER_DEPLOY_DIR || "/opt/opencode-router"
const SERVICE = process.env.RELAYER_DEPLOY_SERVICE || "opencode-router.service"
const SITE_URL = process.env.RELAYER_SITE_URL || "https://opencode.cosymart.top"
const TARGET_HOST = process.env.RELAYER_TARGET_HOST || "100.121.130.36"
const TARGET_PORT = process.env.RELAYER_TARGET_PORT || "3000"
const RELEASE_ID = process.env.OPENCODE_ROUTER_RELEASE_ID || "v0.2.3"
const CONTRACT_VERSION = process.env.OPENCODE_ROUTER_CONTRACT_VERSION || "2026-04-17.cli-grade"
const CACHE_SCHEMA = process.env.OPENCODE_ROUTER_CACHE_SCHEMA || RELEASE_ID

const FILES = [
  "router/pages.js",
  "router/context.js",
  "router/util.js",
  "router/version.js",
  "router/http.js",
  "router/index.js",
  "router/routes/cache.js",
  "router/routes/control.js",
  "router/routes/landing.js",
  "router/routes/proxy.js",
  "router/routes/static.js",
  "router/state.js",
  "router/sync/disk-cache.js",
  "router/sync/watcher.js",
  "router/warm.js",
]

function manifestHash() {
  const hash = crypto.createHash("sha256")
  for (const relative of FILES) {
    const full = path.join(__dirname, relative)
    hash.update(relative)
    hash.update("\n")
    hash.update(fs.readFileSync(full))
    hash.update("\n")
  }
  return hash.digest("hex").slice(0, 16)
}

function exec(conn, command, label) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err)
      let out = ""
      stream.on("data", (d) => { out += d.toString("utf8") })
      stream.stderr.on("data", (d) => { out += d.toString("utf8") })
      stream.on("close", (code) => {
        if (code !== 0) {
          const error = new Error(`${label || "remote command"} failed (code=${code})\n${out}`)
          error.output = out
          reject(error)
          return
        }
        resolve(out)
      })
    })
  })
}

function sftpFastPut(sftp, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { mode: 0o644 }, (err) => err ? reject(err) : resolve())
  })
}

function httpsJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = ""
      res.on("data", (chunk) => { data += chunk.toString("utf8") })
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, headers: res.headers, data: data ? JSON.parse(data) : {} })
        } catch (err) {
          reject(new Error(`Failed to parse JSON from ${url}: ${err.message}\n${data.slice(0, 500)}`))
        }
      })
    })
    req.on("error", reject)
    req.setTimeout(15000, () => req.destroy(new Error(`Timeout fetching ${url}`)))
  })
}

function httpsText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let data = ""
      res.on("data", (chunk) => { data += chunk.toString("utf8") })
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }))
    })
    req.on("error", reject)
    req.setTimeout(15000, () => req.destroy(new Error(`Timeout fetching ${url}`)))
  })
}

async function waitForReady(url, attempts, delayMs) {
  let last = null
  for (let i = 0; i < attempts; i++) {
    last = await httpsJson(url)
    if (last.status === 200 && last.data?.ok === true) return last
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return last
}

async function main() {
  const manifest = manifestHash()
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
  const conn = new Client()

  await new Promise((resolve, reject) => {
    conn.on("ready", resolve)
    conn.on("error", reject)
    conn.connect({ host: HOST, port: 22, username: USER, password: PASS })
  })

  console.log(`[deploy] connected ${HOST}`)
  const backupDir = `${REMOTE_DIR}/.backup-v020-${stamp}`
  const backupCmd = [
    `mkdir -p '${backupDir}'`,
    ...FILES.map((relative) => {
      const remote = `${REMOTE_DIR}/${relative}`
      const backup = `${backupDir}/${relative}`
      return `if [ -f '${remote}' ]; then mkdir -p "$(dirname '${backup}')" && cp '${remote}' '${backup}'; fi`
    }),
    `echo BACKUP_OK`,
  ].join(" && ")
  await exec(conn, backupCmd, "backup")
  console.log(`[deploy] backup ok -> ${backupDir}`)

  const sftp = await new Promise((resolve, reject) => conn.sftp((err, client) => err ? reject(err) : resolve(client)))
  try {
    for (const relative of FILES) {
      const local = path.join(__dirname, relative)
      const remote = `${REMOTE_DIR}/${relative}`
      await exec(conn, `mkdir -p '${path.posix.dirname(remote)}'`, `mkdir ${relative}`)
      await sftpFastPut(sftp, local, remote)
      console.log(`[deploy] uploaded ${relative}`)
    }
  } finally {
    sftp.end()
  }

  const overrideContent = [
    "[Service]",
    `Environment=OPENCODE_ROUTER_RELEASE_ID=${RELEASE_ID}`,
    `Environment=OPENCODE_ROUTER_CONTRACT_VERSION=${CONTRACT_VERSION}`,
    `Environment=OPENCODE_ROUTER_MANIFEST_HASH=${manifest}`,
    `Environment=OPENCODE_ROUTER_CACHE_SCHEMA=${CACHE_SCHEMA}`,
  ].join("\n") + "\n"
  const overrideB64 = Buffer.from(overrideContent, "utf8").toString("base64")
  const overrideCmd = [
    `sudo mkdir -p /etc/systemd/system/${SERVICE}.d`,
    `printf '%s' '${overrideB64}' | base64 -d | sudo tee /etc/systemd/system/${SERVICE}.d/10-v020.conf >/dev/null`,
    `sudo systemctl daemon-reload`,
    `sudo systemctl restart ${SERVICE}`,
    `sleep 4`,
    `sudo systemctl is-active ${SERVICE}`,
  ].join(" && ")
  const restartOut = await exec(conn, overrideCmd, "restart service")
  console.log(`[deploy] service restart ok\n${restartOut.trim()}`)
  conn.end()

  await new Promise((resolve) => setTimeout(resolve, 3000))
  const livez = await httpsJson(`${SITE_URL}/__oc/livez`)
  await httpsJson(`${SITE_URL}/__oc/meta?host=${encodeURIComponent(TARGET_HOST)}&port=${encodeURIComponent(TARGET_PORT)}&client=deploy_probe`).catch(() => null)
  const readyz = await waitForReady(`${SITE_URL}/__oc/readyz`, 12, 1000)
  const modez = await httpsJson(`${SITE_URL}/__oc/modez`)
  const healthz = await httpsJson(`${SITE_URL}/__oc/healthz`)
  const root = await httpsText(`${SITE_URL}/`)

  if (livez.status !== 200) throw new Error(`livez failed: ${livez.status}`)
  if (!livez.data?.release || livez.data.release.releaseId !== RELEASE_ID) throw new Error(`livez release mismatch: ${JSON.stringify(livez.data)}`)
  if (readyz.status !== 200 || readyz.data?.ok !== true) throw new Error(`readyz failed: ${JSON.stringify(readyz.data)}`)
  if (modez.status !== 200 || !Array.isArray(modez.data?.targets)) throw new Error(`modez failed: ${JSON.stringify(modez.data)}`)
  if (healthz.status !== 200 || healthz.data?.ok !== true) throw new Error(`healthz failed: ${JSON.stringify(healthz.data)}`)
  if ((root.headers["x-relayer-release"] || "") !== RELEASE_ID) throw new Error(`root release header mismatch: ${root.headers["x-relayer-release"]}`)
  if ((root.headers["x-relayer-manifest"] || "") !== manifest) throw new Error(`root manifest header mismatch: ${root.headers["x-relayer-manifest"]}`)

  console.log(JSON.stringify({
    releaseId: RELEASE_ID,
    contractVersion: CONTRACT_VERSION,
    manifestHash: manifest,
    livez: livez.data,
    readyz: readyz.data,
    modez: modez.data,
    healthzTargets: healthz.data.targets,
    rootHeaders: {
      release: root.headers["x-relayer-release"],
      contract: root.headers["x-relayer-contract"],
      manifest: root.headers["x-relayer-manifest"],
    },
  }, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
