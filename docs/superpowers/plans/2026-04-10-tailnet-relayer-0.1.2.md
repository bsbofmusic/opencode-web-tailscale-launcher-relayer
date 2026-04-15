# Tailnet Relayer 0.1.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `0.1.2` as a relay-only relayer release that supports official OpenCode, launcher-managed and attach-only targets, and real browser-gated delivery without any fork/plugin dependency.

**Architecture:** `0.1.2` keeps the launcher stable and focuses implementation on the VPS relayer. The relayer gains a target registry, explicit target typing, official-OpenCode compatibility handling, stronger launch admission, VPS-centered warming/caching, and release gates that require real browser success on the live route.

**Tech Stack:** Node.js CommonJS router modules, Windows C# launcher, official OpenCode CLI/web, Playwright-based browser gate, local sandbox scripts under `D:\CODE\opencode-tailscale`.

---

## File Structure

### Public repo relayer core

- Modify: `router/state.js`
  Purpose: add target registry state, target type, admission state, and stronger release-visible state.

- Modify: `router/warm.js`
  Purpose: centralize official OpenCode compatibility, target inspection, auth support, and target-scoped warm logic.

- Modify: `router/routes/control.js`
  Purpose: surface target registry and launch admission truth through `progress`, `events`, and `healthz`.

- Modify: `router/routes/landing.js`
  Purpose: expose target-type-aware entry and clearer target-state explanation.

- Modify: `router/routes/proxy.js`
  Purpose: preserve current sync/runtime behavior while respecting target typing and cleaner admission transitions.

- Modify: `router/sync/watcher.js`
  Purpose: keep active-session coordination but scope it to admitted targets and target-level cache state.

- Modify: `router/util.js`
  Purpose: add small target-type and target-key helpers if needed.

- Modify: `verify-launch-gate.js`
  Purpose: make the browser gate the release truth source for both launcher-managed and attach-only paths.

### Launcher-side working repo alignment

- Modify: `D:\CODE\opencode-tailscale\dist\opencode.cmd`
  Purpose: keep official CLI wrapper behavior stable and auth-free for launcher-managed entry.

- Modify: `D:\CODE\opencode-tailscale\oc-launcher.ini`
- Modify: `D:\CODE\opencode-tailscale\dist\oc-launcher.ini`
  Purpose: ensure launcher-managed startup remains pinned to official CLI only.

- Modify: `D:\CODE\opencode-tailscale\router-sandbox-check.js`
  Purpose: extend regression coverage for target typing, admission outcomes, and browser gate assumptions.

### Docs and release surfaces

- Modify: `README.md`
- Modify: `docs/DEPLOY_VPS.md`
- Modify: `docs/RELEASE-v0.1.1.md`
- Create: `docs/RELEASE-v0.1.2.md`

## Task 1: Stabilize The Official CLI Baseline

**Files:**
- Modify: `D:\CODE\opencode-tailscale\dist\opencode.cmd`
- Modify: `D:\CODE\opencode-tailscale\oc-launcher.ini`
- Modify: `D:\CODE\opencode-tailscale\dist\oc-launcher.ini`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Write the failing baseline assertions into `router-sandbox-check.js` comments**

```js
// New assertions this task enables later:
// - official CLI health returns version 1.4.x
// - session list is non-empty without forked binary
// - launcher wrapper clears auth env for launcher-managed startup
```

- [ ] **Step 2: Keep the wrapper pinned to the official CLI only**

```cmd
@echo off
setlocal
set "OPENCODE_SERVER_PASSWORD="
set "OPENCODE_SERVER_USERNAME="
set "OPENCODE_CONFIG_DIR="
cd /d "D:\CODE"
"C:\Users\Maxlead\AppData\Roaming\npm\node_modules\opencode-ai\node_modules\opencode-windows-x64\bin\opencode.exe" %*
```

- [ ] **Step 3: Keep launcher INI files pointed at the wrapper, not a fork**

```ini
cli_path=D:\CODE\opencode-tailscale\dist\opencode.cmd
```

- [ ] **Step 4: Run the local CLI baseline check**

Run: `node -e "const http=require('http');http.get('http://100.121.130.36:3000/global/health',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(r.statusCode,b))});http.get('http://100.121.130.36:3000/session?limit=3',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>console.log(r.statusCode,b.slice(0,200)))})"`
Expected: `200` for health and a non-empty session payload.

- [ ] **Step 5: Commit the launcher-baseline slice**

```bash
git add D:/CODE/opencode-tailscale/dist/opencode.cmd D:/CODE/opencode-tailscale/oc-launcher.ini D:/CODE/opencode-tailscale/dist/oc-launcher.ini
git commit -m "fix: pin launcher to official opencode cli"
```

## Task 2: Add Target Registry And Target Typing

**Files:**
- Modify: `router/state.js`
- Modify: `router/util.js`
- Modify: `router/routes/control.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Write the failing target-registry assertions**

```js
// New assertions this task enables later:
// - progress returns target.type for launcher-managed and attach-only targets
// - target state is keyed by target identity, not only by the current client
// - healthz shows per-target readiness without conflating target classes
```

- [ ] **Step 2: Add explicit target registry fields to `router/state.js`**

```js
function targetKey(target) {
  return `${target.host}:${target.port}`
}

function targetType(target, cfg) {
  return cfg.launcher_hosts?.includes(target.host) ? "launcher-managed" : "attach-only"
}

function createState(target) {
  return {
    target,
    target_key: targetKey(target),
    target_type: "attach-only",
    target_status: "unknown",
    admission: "probe",
    availability_at: 0,
    failure_reason: null,
    // existing fields remain
  }
}
```

- [ ] **Step 3: Publish target typing through control payloads**

```js
payload.targetType = state.target_type
payload.targetStatus = state.target_status
payload.admission = state.admission
payload.failureReason = state.failure_reason
```

- [ ] **Step 4: Run syntax checks for the target-registry slice**

Run: `node --check ".\router\state.js"; node --check ".\router\routes\control.js"; node --check ".\router\util.js"`
Expected: no output, exit code `0`

- [ ] **Step 5: Commit the target-registry slice**

```bash
git add router/state.js router/routes/control.js router/util.js
git commit -m "feat: add relayer target registry model"
```

## Task 3: Implement Official-OpenCode Compatibility And Admission

**Files:**
- Modify: `router/warm.js`
- Modify: `router/state.js`
- Modify: `router/routes/control.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Write the failing compatibility assertions**

```js
// New assertions this task enables later:
// - official auth-protected targets can be inspected when auth env is present
// - launcher-managed targets surface launcher-unavailable separately from attach-only failures
// - attach-only targets never enter a launcher-start path
```

- [ ] **Step 2: Keep upstream auth support isolated in `router/warm.js`**

```js
function upstreamAuth() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return null
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
}
```

- [ ] **Step 3: Add explicit admission decisions in warm/control state**

```js
function admit(state) {
  if (state.target_type === "attach-only" && state.offline) return "attach-only-unavailable"
  if (state.target_type === "launcher-managed" && state.offline) return "launcher-managed-unavailable"
  if (state.meta?.ready) return "enter"
  return "probe"
}
```

- [ ] **Step 4: Publish admission outcomes in `progress` and `healthz`**

Run: `node --check ".\router\warm.js"; node --check ".\router\routes\control.js"`
Expected: no output, exit code `0`

- [ ] **Step 5: Commit the compatibility/admission slice**

```bash
git add router/warm.js router/state.js router/routes/control.js
git commit -m "feat: add official opencode compatibility and admission states"
```

## Task 4: Strengthen VPS-Centered Warm And Cache Scheduling

**Files:**
- Modify: `router/warm.js`
- Modify: `router/heavy.js`
- Modify: `router/sync/watcher.js`
- Modify: `router/routes/control.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Write the failing scheduling assertions**

```js
// New assertions this task enables later:
// - active session stays higher priority than old-history work
// - different targets keep separate warm and cache state
// - repeated target failures back off instead of thrashing
```

- [ ] **Step 2: Add per-target backoff/failure budget state**

```js
state.failure_count = 0
state.backoff_until = 0
state.last_failure_at = 0
```

- [ ] **Step 3: Gate heavy/background scheduling on target readiness and backoff**

```js
if (state.backoff_until && Date.now() < state.backoff_until) return
```

- [ ] **Step 4: Keep watcher active-session-first while respecting target-level backoff**

Run: `node --check ".\router\warm.js"; node --check ".\router\heavy.js"; node --check ".\router\sync\watcher.js"`
Expected: no output, exit code `0`

- [ ] **Step 5: Commit the warm/cache slice**

```bash
git add router/warm.js router/heavy.js router/sync/watcher.js router/routes/control.js
git commit -m "feat: strengthen relayer warm and cache scheduling"
```

## Task 5: Reconcile Entry, Recovery, And Browser Gate

**Files:**
- Modify: `router/routes/landing.js`
- Modify: `router/routes/proxy.js`
- Modify: `router/pages.js`
- Modify: `verify-launch-gate.js`
- Test: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Write the failing launch/recovery assertions**

```js
// New assertions this task enables later:
// - desktop and mobile both leave /__oc/launch for launcher-managed targets
// - attach-only unavailable targets fail into an explicit state instead of hanging
// - no login prompt appears on the launcher-managed target path
```

- [ ] **Step 2: Make landing/progress text reflect target type and admission state**

```js
// examples only
// launcher-managed unavailable -> "Launcher machine is reachable but OpenCode is not ready yet"
// attach-only unavailable -> "Target machine is attach-only and not currently serving OpenCode web"
```

- [ ] **Step 3: Keep `verify-launch-gate.js` strict about browser truth**

```js
// keep both profiles required by default
// classify stuck progress loop separately from explicit failure pages
```

- [ ] **Step 4: Run the local browser gate**

Run: `node .\verify-launch-gate.js`
Expected: `ok=true` and `reason=session-route` for the configured local test profile.

- [ ] **Step 5: Commit the entry/recovery slice**

```bash
git add router/routes/landing.js router/routes/proxy.js router/pages.js verify-launch-gate.js
git commit -m "feat: harden relayer entry and browser recovery gate"
```

## Task 6: Release Surfaces And Live Delivery Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/DEPLOY_VPS.md`
- Modify: `docs/RELEASE-v0.1.1.md`
- Create: `docs/RELEASE-v0.1.2.md`
- Modify: `D:\CODE\opencode-tailscale\router-sandbox-check.js`

- [ ] **Step 1: Update docs to describe launcher-managed vs attach-only targets**

```md
- launcher-managed targets may auto-start official OpenCode through the launcher
- attach-only targets may be probed and entered if already available, but are never remotely started
```

- [ ] **Step 2: Add release-gate wording that forbids shipping without real browser evidence**

```md
- syntax and sandbox checks are preflight only
- the live desktop+mobile browser gate is the release truth source
```

- [ ] **Step 3: Run the live browser gate for both profiles**

Run: `node .\verify-launch-gate.js`
Expected: JSON output with `ok=true` and `reason=session-route` for `desktop` and `mobile`.

- [ ] **Step 4: Capture the gate evidence into release notes**

```md
- desktop: ok=true, reason=session-route, durationMs=<actual>
- mobile: ok=true, reason=session-route, durationMs=<actual>
```

- [ ] **Step 5: Commit the release surface**

```bash
git add README.md docs/DEPLOY_VPS.md docs/RELEASE-v0.1.1.md docs/RELEASE-v0.1.2.md D:/CODE/opencode-tailscale/router-sandbox-check.js
git commit -m "docs: publish relayer 0.1.2 release surfaces"
```

## Spec Coverage Check

- official OpenCode-only baseline: Tasks 1 and 3
- launcher-managed vs attach-only split: Tasks 2, 3, and 6
- target registry: Task 2
- VPS-centered warm/cache engine: Task 4
- safer current-page coordination and recovery: Tasks 4 and 5
- browser-gated release: Tasks 5 and 6

## Placeholder Scan

- Every task has exact file paths.
- Every task has explicit verification commands.
- No undefined fork/plugin work is included.

## Type And Naming Consistency

- target types stay fixed as `launcher-managed` and `attach-only`
- admission states stay explicit and separate from sync state
- sync actions remain `noop`, `soft-refresh`, `defer`, `re-enter`
