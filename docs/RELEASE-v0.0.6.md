# OpenCode Tailnet Launcher v0.0.6

## Summary

- Fixed the last launch-state bug introduced by background refresh in `v0.0.5`.
- Stale-but-usable cache now counts as launchable, so the progress page no longer blocks on `Reading remote session index...` when a valid latest session is already cached.

## What Changed

- `__oc/progress` now exposes `launchReady` separately from the refresh completion state.
- The launch page redirects as soon as a cached latest session is available.
- Background refresh can continue without forcing the launch page to wait.
- `__oc/meta` now prefers any valid cached session state instead of waiting for a fresh re-warm.

## Validation

Validated before and after deployment with:

- local syntax checks
- repeated self-contained sandbox runs
- live cold-start tests after restarting the VPS router before each run
- three cold user-agent profiles:
  - Android Chrome
  - WeChat in-app browser
  - desktop Chrome

All three cold-start tests returned `launchReady: true` on the first progress poll while refresh remained active in the background.

## Notes

- This release improves launch determinism. It does not remove the remaining upstream message-size cost inside very large sessions.
