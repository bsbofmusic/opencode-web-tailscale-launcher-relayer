# OpenCode Tailnet Launcher v0.1.1

## Summary

- Added relay-only active-session sync on top of the stable launch and cache baseline.
- Added router-owned sync actions so the open session page can move between `live`, `stale`, `protected`, and `offline` states without upstream `opencode` patches.
- Added inline session-page runtime injection and sync response headers for post-launch coordination and diagnosis.

## What Changed

### Active-session sync after launch

Earlier releases solved cold entry, cache warmup, and offline fallback, but the already-open page could still drift behind another terminal.

`v0.1.1` closes that gap by letting the router:

- track a head summary for the current client view
- detect when the active session head advances remotely
- mark the page stale with an explicit reason
- choose a safe action: `noop`, `soft-refresh`, `defer`, or `re-enter`

### Inline router-owned runtime

The router now injects one small inline runtime into proxied session HTML only.

That runtime:

- subscribes to router SSE events
- reads router progress state
- updates a small sync chip on the page
- follows router-selected actions instead of inventing its own refresh policy

The landing page and non-session routes do not receive this runtime.

### Sync diagnostics

Session HTML responses now include:

- `X-OC-Relay-Sync-State`
- `X-OC-Relay-Stale-Reason`
- `X-OC-Relay-Action`

`/__oc/healthz` also reports stale and protected client counts so operators can see why the router refreshed or waited.

## Pre-Ship Validation

The previous validation stack was not enough because it could pass while a real browser still stayed stuck on `OpenCode Launching`.

Pre-ship validation now has four layers:

- `node --check` on changed router files in the public repo
- `node .\router-sandbox-check.js` from `D:\CODE\opencode-tailscale`
- launcher build from `launcher\build-oc-launcher.ps1`
- real-browser gate from `node .\verify-launch-gate.js`

Only the first three passing is not sufficient. The live browser gate must also pass.

The browser gate is specifically meant to catch the failure mode where `__oc/progress` looks healthy but the browser never exits `/__oc/launch`.

## Notes

- This release stays relay-only. No upstream `opencode` source changes are required.
- The router now coordinates the open page after launch, not just the entry flow before launch.
- `v0.1.2` supersedes this release as the formal relayer definition when official-OpenCode compatibility and target typing are required.
