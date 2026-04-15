# Tailnet Sync 0.1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `0.1.1` so the router can detect when the current session page is stale, choose a safe sync action, and bring the page back into alignment without modifying upstream `opencode`.

**Architecture:** `0.1.1` extends the existing relay-only router with a head-summary model, stale classifier, refresh coordinator, and one small router-owned browser runtime injected into session HTML. Validation stays split across router syntax checks in the public repo, sandbox verification in `D:\CODE\opencode-tailscale`, and live relay checks against a real Tailscale target. A release is only shippable when a real browser leaves `/__oc/launch` and reaches a `/session/` route on the live VPS target.

**Tech Stack:** Node.js CommonJS router modules, plain browser JavaScript runtime, existing router SSE/event bus, Windows C# launcher, Node-based sandbox scripts in `D:\CODE\opencode-tailscale`.

---

## Background

This plan exists because the project already proved the relay-only baseline in `0.0.12`, but that baseline still stopped short of the user-visible sync goal.

The path from `0.0.9` to `0.0.12` established these facts:

- the VPS relay can already keep launch fast enough, preserve offline readability, and isolate clients correctly
- the router can already observe health changes, session-list changes, and active-session message fetches
- the relay can already bias freshness toward the active session through cache bypass and priority headers
- the remaining gap is not cold start, but what happens after the page is already open

The failed branch taught a second important lesson:

- plugin and fork work inside `tmp-opencode-src` could produce stronger app-native sync, but that route violates the project boundary because it depends on upstream `opencode` modifications
- the formal delivery repo must stay relay-only, launcher-only, and documentation-only

That leaves one valid `0.1.1` direction: use the router as the long-lived sync authority for the already-open session page.

## Problem Statement

Before `0.1.1`, the router can see when the session moved forward, but the current page still behaves like a mostly passive upstream page after launch.

That causes four concrete product problems:

- the same session can advance on another terminal while the current page keeps showing an older head
- the user often has to manually switch sessions or refresh to catch up
- the router already knows two risky situations, PTY activity and idle recovery, but the browser page cannot participate in that safety policy yet
- operators can see launch and cache behavior, but they cannot yet explain the post-launch sync decision path end to end

## Why This Version

`0.1.1` is not a cold-start release and not a UI rewrite. It is the first release whose job starts after launch succeeds.

The purpose of this version is to close the loop between:

- what the router observes
- what the router decides
- what the current page actually does

The release deliberately chooses router-owned sync over deeper upstream integration because the project constraints are already fixed:

- no upstream source patch
- no required plugin runtime
- no forked app delivery

## Intended Outcome

If this plan lands correctly, the user-visible outcome changes in a specific way:

- `0.0.12` behavior: the router gets the user into the right session and keeps cache and relay behavior stable
- `0.1.1` behavior: the router also helps the already-open session stay aligned when that session changes elsewhere

This is the precise product consequence of the release:

- less manual refresh and fewer manual session switches
- safer behavior during idle recovery and PTY activity
- clearer explanations when the router refreshes, waits, or refuses to refresh
- a more native-feeling multi-terminal experience without crossing the relay-only boundary

Validation correction:

- syntax, sandbox, and build checks are preflight only
- the live browser gate is the final truth source for ship readiness
- if a browser stays stuck on `OpenCode Launching`, the release is not shippable regardless of preflight results

## File Structure

### Router state and coordination

- Modify: `router/state.js`
Purpose: add head summaries, sync state fields, and action bookkeeping for each client.

- Modify: `router/sync/watcher.js`
Purpose: compare previous and next active-session heads, classify stale reasons, and emit sync-specific events.

- Modify: `router/routes/control.js`
Purpose: expose sync state through `/__oc/progress`, `/__oc/events`, and `/__oc/healthz`, and compute router-owned actions.

### Router runtime delivery

- Modify: `router/pages.js`
Purpose: deliver the final inline sync runtime inside session HTML and execute router-selected actions without an extra deployed runtime file.

- Modify: `router/routes/static.js`
Purpose: serve the runtime asset at `/__oc/runtime/session-sync.js`.

- Modify: `router/dispatch.js`
Purpose: route the runtime asset through the existing static path handler.

- Modify: `router/routes/proxy.js`
Purpose: inject the runtime into session HTML only and attach sync headers to session responses.

- Modify: `router/pages.js`
Purpose: keep launch-page vocabulary aligned with the new sync states and headers, and host the inline session sync runtime.

### Release and verification

- Modify: `D:\CODE\opencode-tailscale\router-sandbox-check.js`
Purpose: add regression coverage for stale detection, protected mode, runtime injection, and `re-enter` escalation.

- Modify: `launcher/OpenCodeTailnetLauncher.cs`
Purpose: bump version metadata.

- Modify: `README.md`
Purpose: document `0.1.1` active-session sync behavior.

- Modify: `docs/DEPLOY_VPS.md`
Purpose: document runtime asset serving, sync headers, and validation flow.

- Create: `docs/RELEASE-v0.1.1.md`
Purpose: publish release notes.

## Task 1: Add Head Summary And Client Sync State

**Files:**
- Modify: `router/state.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Write the failing state assertions into the sandbox plan comments**

```js
// New assertions this task enables later:
// - progress.data.syncState starts as "live" or "syncing", never undefined
// - progress.data.viewHead.sessionID matches progress.data.meta.sessions.latest.id after a successful launch
// - a failed HTML open does not replace progress.data.viewHead
```

- [ ] **Step 2: Add the new state shape to `router/state.js`**

```js
function emptyHead() {
  return {
    sessionID: null,
    directory: null,
    messageCount: 0,
    tailID: null,
    updatedAt: 0,
  }
}

function createState(target) {
  return {
    target,
    config: undefined,
    clients: new Map(),
    latestHead: emptyHead(),
    activeHeads: new Map(),
    syncVersion: 0,
    lastSyncAt: 0,
    meta: undefined,
    metaAt: 0,
    sessionList: [],
    lists: new Map(),
    messages: new Map(),
    details: new Map(),
  }
}

function createClientState(id) {
  return {
    id,
    warm: {
      active: false,
      ready: false,
      first: true,
      percent: 0,
      stage: "idle",
      note: "Waiting",
      cachedAt: 0,
      latestSessionID: undefined,
      latestDirectory: undefined,
      snapshotCount: 0,
      error: null,
    },
    lastError: null,
    lastAccessAt: now(),
    activeSessionID: undefined,
    activeDirectory: undefined,
    view: null,
    viewHead: emptyHead(),
    remoteHead: emptyHead(),
    syncState: "idle",
    staleReason: null,
    lastAction: "noop",
    lastActionAt: 0,
    refreshFailures: 0,
    resumeSafeUntil: 0,
    resumeReason: null,
  }
}
```

- [ ] **Step 3: Add concrete helper functions to `router/state.js`**

```js
function setClientView(client, view) {
  client.view = view
}

function setClientHeads(state, client, viewHead, remoteHead) {
  client.viewHead = { ...viewHead }
  client.remoteHead = { ...remoteHead }
  state.activeHeads.set(client.id, { ...remoteHead })
  state.latestHead = { ...remoteHead }
  state.syncVersion += 1
  state.lastSyncAt = now()
}

function setSyncState(client, syncState, staleReason, lastAction) {
  client.syncState = syncState
  client.staleReason = staleReason
  client.lastAction = lastAction
  client.lastActionAt = now()
}
```

- [ ] **Step 4: Wire successful session HTML opens to the new state**

```js
function rememberActiveSession(client, reqUrl) {
  const { decodeDir } = require("./util")
  const match = reqUrl.pathname.match(/^\/[^/]+\/session\/([^/]+)$/)
  if (!match) return
  const directory = decodeDir(reqUrl.pathname.split("/")[1] || "") || client.activeDirectory
  const sessionID = decodeURIComponent(match[1])
  client.activeDirectory = directory
  client.activeSessionID = sessionID
  setClientView(client, { directory, sessionID, pathname: reqUrl.pathname })
}
```

- [ ] **Step 5: Run the first syntax check**

Run: `node --check ".\router\state.js"`
Expected: no output, exit code `0`

- [ ] **Step 6: Commit the state-model slice**

```bash
git add router/state.js
git commit -m "feat: add tailnet sync state model"
```

## Task 2: Emit Semantic Sync Events From The Watcher

**Files:**
- Modify: `router/sync/watcher.js`
- Modify: `router/sync/bus.js`
- Modify: `router/state.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Add the failing sandbox expectations for stale classification**

```js
// New assertions this task enables later:
// - unrelated session change does not set syncState to "stale"
// - active-session head advance emits an SSE payload containing event: sync-stale
// - target offline emits syncState "offline"
```

- [ ] **Step 2: Add head-derivation helpers to `router/sync/watcher.js`**

```js
function headFromMessages(sessionID, directory, body) {
  const rows = Array.isArray(JSON.parse(body || "[]")) ? JSON.parse(body || "[]") : []
  const tail = rows.length ? rows[rows.length - 1] : null
  return {
    sessionID,
    directory,
    messageCount: rows.length,
    tailID: tail?.id || null,
    updatedAt: Date.now(),
  }
}

function sameHead(a, b) {
  return Boolean(
    a &&
    b &&
    a.sessionID === b.sessionID &&
    a.directory === b.directory &&
    a.messageCount === b.messageCount &&
    a.tailID === b.tailID,
  )
}
```

- [ ] **Step 3: Emit semantic sync events when the active head changes**

```js
function emitSyncEvent(state, client, reason, action) {
  emitTargetEvent(state.target, "sync-stale", {
    client: client.id,
    sessionID: client.activeSessionID,
    directory: client.activeDirectory,
    reason,
    action,
    state: client.syncState,
    version: state.syncVersion,
    timestamp: Date.now(),
  })
}
```

- [ ] **Step 4: Classify stale versus unrelated updates in the watcher loop**

```js
for (const client of state.clients.values()) {
  if (!client.activeSessionID || !client.activeDirectory) continue
  const key = `${client.activeDirectory}\n${client.activeSessionID}\n80`
  const entry = state.messages.get(key)
  if (!entry) continue
  const nextHead = headFromMessages(client.activeSessionID, client.activeDirectory, entry.body)
  const prevHead = client.remoteHead
  if (sameHead(prevHead, nextHead)) continue
  setClientHeads(state, client, client.viewHead, nextHead)
  setSyncState(client, "stale", "head-advanced", "noop")
  emitSyncEvent(state, client, "head-advanced", "noop")
}
```

- [ ] **Step 5: Surface offline state as a sync event**

```js
if (becameOffline) {
  for (const client of state.clients.values()) {
    setSyncState(client, "offline", "target-offline", "noop")
    emitTargetEvent(state.target, "sync-stale", {
      client: client.id,
      sessionID: client.activeSessionID || null,
      directory: client.activeDirectory || null,
      reason: "target-offline",
      action: "noop",
      state: "offline",
      version: state.syncVersion,
      timestamp: Date.now(),
    })
  }
}
```

- [ ] **Step 6: Run syntax checks for the watcher slice**

Run: `node --check ".\router\sync\watcher.js"; node --check ".\router\sync\bus.js"`
Expected: no output, exit code `0`

- [ ] **Step 7: Commit the watcher slice**

```bash
git add router/sync/watcher.js router/sync/bus.js router/state.js
git commit -m "feat: classify tailnet sync stale events"
```

## Task 3: Add Router-Owned Sync Actions To Control Routes

**Files:**
- Modify: `router/routes/control.js`
- Modify: `router/state.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Add the failing sandbox expectations for action selection**

```js
// New assertions this task enables later:
// - resume-safe stale path returns lastAction "defer"
// - PTY stale path returns lastAction "defer"
// - repeated refresh mismatch returns lastAction "re-enter"
// - offline path returns lastAction "noop"
```

- [ ] **Step 2: Add a pure coordinator helper to `router/routes/control.js`**

```js
function selectSyncAction(state, client) {
  if (state.offline) return "noop"
  if (client.syncState !== "stale") return "noop"
  if (clientSafeMode(client) || backgroundWarmPaused(state)) return "defer"
  if (!client.view || !client.activeSessionID || !client.activeDirectory) return "re-enter"
  if ((client.refreshFailures || 0) >= 2) return "re-enter"
  return "soft-refresh"
}
```

- [ ] **Step 3: Publish sync fields in `progressPayload()`**

```js
const action = selectSyncAction(state, client)
payload.syncState = client.syncState || (state.offline ? "offline" : "live")
payload.staleReason = client.staleReason || null
payload.lastAction = action
payload.lastActionAt = client.lastActionAt || 0
payload.viewHead = client.viewHead || null
payload.remoteHead = client.remoteHead || null
payload.protected = action === "defer"
```

- [ ] **Step 4: Emit sync-action events before returning SSE payloads**

```js
const action = selectSyncAction(state, client)
setSyncState(client, payload.syncState, payload.staleReason, action)
emitTargetEvent(state.target, "sync-action", {
  client: client.id,
  sessionID: client.activeSessionID || null,
  directory: client.activeDirectory || null,
  reason: client.staleReason || null,
  action,
  state: client.syncState,
  version: state.syncVersion,
  timestamp: Date.now(),
})
```

- [ ] **Step 5: Extend `healthPayload()` with sync counters**

```js
const staleClients = [...state.clients.values()].filter((c) => c.syncState === "stale").length
const protectedClients = [...state.clients.values()].filter((c) => c.lastAction === "defer").length
return {
  target: state.target,
  launchReady: Boolean(state.meta?.ready && state.meta?.sessions?.latest?.id),
  staleClients,
  protectedClients,
  lastSyncVersion: state.syncVersion,
  lastSyncAt: state.lastSyncAt,
  // keep existing fields
}
```

- [ ] **Step 6: Run syntax checks for the control slice**

Run: `node --check ".\router\routes\control.js"`
Expected: no output, exit code `0`

- [ ] **Step 7: Commit the control-plane slice**

```bash
git add router/routes/control.js router/state.js
git commit -m "feat: add relay sync action coordinator"
```

## Task 4: Serve And Inject The Session Sync Runtime

**Files:**
- Create: `router/runtime/session-sync.js`
- Modify: `router/routes/static.js`
- Modify: `router/dispatch.js`
- Modify: `router/routes/proxy.js`
- Modify: `router/pages.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Write the failing runtime assertions into the sandbox plan comments**

```js
// New assertions this task enables later:
// - session HTML includes /__oc/runtime/session-sync.js exactly once
// - landing HTML does not include the runtime
// - sync-stale + soft-refresh does not create a reload loop
```

- [ ] **Step 2: Create `router/runtime/session-sync.js`**

```js
"use strict"

(function () {
  const chip = document.createElement("div")
  chip.id = "oc-tailnet-sync"
  chip.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 10px;border-radius:999px;background:#08111d;color:#eef4ff;font:12px/1.2 Inter,Segoe UI,sans-serif;border:1px solid #20314b;box-shadow:0 8px 24px rgba(0,0,0,.35)"
  document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(chip) }, { once: true })

  function setLabel(state, reason) {
    chip.textContent = reason ? `Tailnet ${state}: ${reason}` : `Tailnet ${state}`
  }

  async function readProgress() {
    const url = `/__oc/progress${location.search ? location.search + "&" : "?"}client=${encodeURIComponent(new URLSearchParams(location.search).get("client") || "")}`
    const res = await fetch(url, { credentials: "same-origin", cache: "no-store" })
    return await res.json()
  }

  async function applyAction(data) {
    setLabel(data.syncState || "live", data.staleReason || "")
    if (data.lastAction === "soft-refresh") location.replace(location.pathname + location.search)
    if (data.lastAction === "re-enter" && data.launch) location.replace(`/${data.launch.directory}/session/${encodeURIComponent(data.launch.sessionID)}?host=${encodeURIComponent(data.target.host)}&port=${encodeURIComponent(data.target.port)}&client=${encodeURIComponent(data.launch.client)}`)
  }

  const stream = new EventSource(`/__oc/events${location.search ? location.search + "&" : "?"}client=${encodeURIComponent(new URLSearchParams(location.search).get("client") || "")}`)
  stream.addEventListener("sync-stale", async function () { await applyAction(await readProgress()) })
  stream.addEventListener("sync-action", async function () { await applyAction(await readProgress()) })
  stream.addEventListener("target-health-changed", async function () { await applyAction(await readProgress()) })
  setLabel("live", "")
})()
```

- [ ] **Step 3: Serve the runtime asset from `router/routes/static.js` and `router/dispatch.js`**

```js
const fs = require("fs")
const path = require("path")

function serveStatic(ctx, res) {
  if (ctx.pathname === "/__oc/runtime/session-sync.js") {
    const file = path.join(__dirname, "..", "runtime", "session-sync.js")
    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" })
    res.end(fs.readFileSync(file, "utf8"))
    return
  }
  // existing branches stay here
}
```

- [ ] **Step 4: Inject the runtime into session HTML in `router/routes/proxy.js`**

```js
function injectRuntime(body) {
  const tag = '<script src="/__oc/runtime/session-sync.js"></script>'
  if (body.includes(tag)) return body
  if (body.includes("</body>")) return body.replace("</body>", `${tag}</body>`)
  return `${body}${tag}`
}

if (guardHtml && ok) {
  const type = String(headers["content-type"] || "")
  if (type.includes("text/html")) {
    body = injectRuntime(body)
    headers["content-length"] = Buffer.byteLength(body, "utf8")
    headers["x-oc-relay-sync-state"] = client.syncState || "live"
    headers["x-oc-relay-stale-reason"] = client.staleReason || ""
    headers["x-oc-relay-action"] = client.lastAction || "noop"
  }
}
```

- [ ] **Step 5: Keep the launch page vocabulary aligned in `router/pages.js`**

```js
function label(value) {
  const map = {
    connect: "Connecting to remote OpenCode...",
    index: "Reading remote session index...",
    snapshot: "Caching recent session snapshots on the VPS...",
    ready: "Cache ready. Opening the latest session...",
    syncing: "Syncing the current session...",
    protected: "Waiting for a safer sync window...",
    offline: "Target offline. Using the last known router state...",
    error: "The VPS could not warm this target.",
    idle: "Preparing...",
  }
  return map[value] || "Preparing..."
}
```

- [ ] **Step 6: Run syntax checks for the runtime slice**

Run: `node --check ".\router\routes\static.js"; node --check ".\router\routes\proxy.js"; node --check ".\router\pages.js"; node --check ".\router\runtime\session-sync.js"`
Expected: no output, exit code `0`

- [ ] **Step 7: Commit the runtime-delivery slice**

```bash
git add router/runtime/session-sync.js router/routes/static.js router/dispatch.js router/routes/proxy.js router/pages.js
git commit -m "feat: inject relay runtime for session sync"
```

## Task 5: Extend The Sandbox And Run Verification

**Files:**
- Modify: `D:\CODE\opencode-tailscale\router-sandbox-check.js`
- Test: `router/**/*.js`

- [ ] **Step 1: Add a runtime-injection regression to `D:\CODE\opencode-tailscale\router-sandbox-check.js`**

```js
const sessionHtml = await fetch(`${base}/${encodeDir(directory)}/session/ses_latest?${client}`)
const sessionText = await sessionHtml.text()
assert.equal((sessionText.match(/__oc\/runtime\/session-sync\.js/g) || []).length, 1)

const landing = await fetch(`${base}/`)
const landingText = await landing.text()
assert.equal(landingText.includes("/__oc/runtime/session-sync.js"), false)
```

- [ ] **Step 2: Add a stale-event regression to the sandbox**

```js
const sse = await connectSse(`${base}/__oc/events?${client}`)
await fetch(`http://127.0.0.1:${upstreamPort}/__debug/append-latest`, { method: "POST" })
const seen = await sse.waitFor("sync-stale")
assert(seen.includes("head-advanced"))
await sse.close()
```

- [ ] **Step 3: Add protected-mode coverage to the sandbox**

```js
const socket = await openSocket(`/${encodeDir(directory)}/session/ses_latest?${client}`)
const protectedProgress = await getJson(`${base}/__oc/progress?${client}`)
assert.equal(protectedProgress.data.protected, true)
assert.equal(protectedProgress.data.lastAction, "defer")
socket.destroy()
```

- [ ] **Step 4: Run public-repo syntax verification**

Run: `node --check ".\router\state.js"; node --check ".\router\sync\watcher.js"; node --check ".\router\routes\control.js"; node --check ".\router\routes\proxy.js"; node --check ".\router\routes\static.js"; node --check ".\router\pages.js"; node --check ".\router\runtime\session-sync.js"`
Expected: no output, exit code `0`

- [ ] **Step 5: Run sandbox verification from the local working repo**

Run: `node ".\router-sandbox-check.js"`
Workdir: `D:\CODE\opencode-tailscale`
Expected: exits `0` after covering launch, cache, stale event, protected mode, runtime injection, and offline recovery

- [ ] **Step 6: Commit the verification slice**

```bash
git add "D:\CODE\opencode-tailscale\router-sandbox-check.js"
git commit -m "test: cover tailnet sync 0.1.1 router flows"
```

## Task 6: Update Release Surface And Ship The Docs

**Files:**
- Modify: `launcher/OpenCodeTailnetLauncher.cs`
- Modify: `README.md`
- Modify: `docs/DEPLOY_VPS.md`
- Create: `docs/RELEASE-v0.1.1.md`

- [ ] **Step 1: Bump the launcher version string**

```csharp
private const string AppVersion = "v0.1.1";
```

- [ ] **Step 2: Update `README.md` with the new behavior summary**

```md
- Active-session sync for the currently open session page
- Router-owned sync runtime injected into session HTML only
- Safe refresh actions: `soft-refresh`, `defer`, `re-enter`, `noop`
- Sync diagnostics in `/__oc/events`, `/__oc/progress`, `/__oc/healthz`, and `X-OC-Relay-Sync-*` headers
```

- [ ] **Step 3: Update `docs/DEPLOY_VPS.md` with the new validation section**

```md
## 0.1.1 Sync Verification

After deploy, verify all of the following:

1. `curl -I https://your-domain.example.com/encoded-dir/session/session-id?...` returns `X-OC-Relay-Sync-State`
2. opening a session page loads `/__oc/runtime/session-sync.js`
3. `/__oc/healthz` reports sync counters
4. two terminals on the same session converge without a manual session switch
```

- [ ] **Step 4: Create `docs/RELEASE-v0.1.1.md`**

```md
# OpenCode Tailnet Launcher v0.1.1

## Summary

- Added relay-only active-session sync on top of the persistent router shell.
- Added router-owned sync actions and session-page runtime injection without patching upstream `opencode`.
- Extended diagnostics with sync state, stale reasons, and action reporting.

## Validation

- `node --check` on all changed router files
- `node .\router-sandbox-check.js` from `D:\CODE\opencode-tailscale`
- live relay verification against a real tailnet target
```

- [ ] **Step 5: Run the launcher build to confirm the version bump**

Run: `powershell -ExecutionPolicy Bypass -File .\launcher\build-oc-launcher.ps1`
Expected: build succeeds and emits `launcher\dist\OpenCodeTailnetLauncher.exe`

- [ ] **Step 6: Commit the release surface**

```bash
git add launcher/OpenCodeTailnetLauncher.cs README.md docs/DEPLOY_VPS.md docs/RELEASE-v0.1.1.md
git commit -m "docs: publish tailnet sync 0.1.1 release surface"
```

## Release Narrative

The release notes and README changes in Task 6 must preserve the full cause-and-effect story instead of listing features only.

The narrative that must survive into public docs is:

- `0.0.12` solved entry, cache, and fallback stability
- `0.1.1` solves the post-launch stale-page gap
- the solution is still relay-only
- the runtime is router-owned and injected only into session HTML
- the router now exposes not just that something changed, but what action it selected and why

## Spec Coverage Check

- Session Head Authority: Task 1
- Stale Classifier: Task 2
- Refresh Coordinator: Task 3
- Relay Runtime: Task 4
- Active-First Watcher: Tasks 2 and 5
- Operator Surface: Tasks 3, 4, and 6
- Verification Matrix: Task 5 and Task 6
- Delivery Package: Task 6

## Placeholder Scan

- The plan contains no unresolved placeholder markers.
- The plan does not defer testing to a later undefined step.
- The plan uses concrete file paths for every planned change.

## Type And Naming Consistency

- Router sync actions stay fixed as `noop`, `soft-refresh`, `defer`, `re-enter`
- Browser sync states stay fixed as `idle`, `live`, `syncing`, `stale`, `protected`, `offline`
- Head fields stay fixed as `sessionID`, `directory`, `messageCount`, `tailID`, `updatedAt`
