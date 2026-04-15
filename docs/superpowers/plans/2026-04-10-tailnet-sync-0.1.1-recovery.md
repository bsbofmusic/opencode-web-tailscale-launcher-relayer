# Tailnet Sync 0.1.1 Recovery Plan

**Goal:** Recover from the incorrect partial delivery state and only allow release after the local CLI, VPS router, and real browser gate all pass together.

## Facts

- A local commit exists, but it has not been pushed to remote.
- The previous execution drifted from the plan by treating partial validation as release evidence.
- The critical user-visible failure was a browser stuck on `/__oc/launch`.
- The root causes found so far are:
  - the local port `3000` was previously served by a forked `opencode` binary
  - the official `opencode` CLI requires environment-aware startup handling
  - the VPS router needed the new `0.1.1` code and correct upstream access configuration

## Hard Rules

- Do not push anything until all gates below pass.
- Do not treat syntax, sandbox, or partial HTTP checks as release proof.
- Do not use any forked `opencode` binary.
- The launcher must start the official global CLI through a wrapper that clears upstream auth env when direct entry is required.

## Recovery Tasks

### Task 1: Local CLI Baseline

- Ensure port `3000` is served by the official global `opencode` binary only.
- Ensure launcher config points to the wrapper under `dist/opencode.cmd`, not a forked binary.
- Ensure `GET /global/health` on `100.121.130.36:3000` returns `200` and version `1.4.3`.
- Ensure `GET /session?limit=5` returns a non-empty session list.

### Task 2: VPS Router Baseline

- Ensure VPS router files match the local `0.1.1` router implementation.
- Ensure the systemd service is restarted after deploy.
- Ensure `/__oc/progress` on VPS returns `launchReady=true`, `offline=false`, and includes `syncState`/`viewHead` fields.

### Task 3: Browser Gate

- Run `verify-launch-gate.js` against the live VPS target.
- Run both profiles: `desktop,mobile`.
- Success criteria for each profile:
  - `ok=true`
  - `reason=session-route`
  - final URL is a real `/session/` route
  - no login prompt and no stuck launch page

### Task 4: Release Evidence

- Capture the final gate JSON evidence files.
- Update release notes with the actual successful browser gate results.
- Only then create the final commit and push.

## Current Checklist

- [x] Identify whether remote push happened
- [x] Prove current remote branch is not updated yet
- [ ] Re-run local CLI baseline checks from a clean state
- [ ] Re-run VPS router baseline checks from a clean state
- [ ] Re-run browser gate for both desktop and mobile in one final pass
- [ ] Update release notes with real evidence
- [ ] Commit the corrected state
- [ ] Push to remote
