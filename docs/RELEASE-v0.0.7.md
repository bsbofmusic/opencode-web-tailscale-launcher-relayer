# OpenCode Tailnet Launcher v0.0.7

## Summary

- Reworked the VPS cache flow so launch only waits for minimal latest-session metadata.
- Session detail and message snapshots now build quietly in the background instead of blocking launch.
- Added a lightweight router health endpoint to inspect cache state and queue pressure.

## What Changed

### Async background caching

The VPS router now splits cache work into two layers:

- foreground launch path: fetch just enough metadata to open the latest session
- background cache path: fill session detail and message snapshots after the user is already inside OpenCode

This prevents cold opens from stalling on remote session-index reads when the router already has a usable cached session.

### Foreground vs background isolation

- foreground heavy requests still use a bounded per-target queue
- background snapshot work runs in a separate low-priority queue
- background cache work only proceeds when the foreground queue is idle

### Router observability

Added `GET /__oc/healthz` with a small summary of:

- target count
- launch readiness
- refresh state
- queue lengths
- cache stats
- recent cache error for each tracked target

## Validation

Validated before and after deployment with:

- local syntax checks
- repeated self-contained sandbox runs updated for launch-ready-before-background-complete behavior
- live cold-start tests that restarted the VPS router before each run
- three cold browser profiles:
  - Android Chrome
  - WeChat in-app browser
  - desktop Chrome

All three profiles reached `launchReady: true` on the first progress window while background caching continued separately.

## Notes

- This release focuses on launch determinism and non-blocking cache behavior.
- Large upstream sessions can still cost time after launch when the app requests additional live history outside the warmed snapshot.
