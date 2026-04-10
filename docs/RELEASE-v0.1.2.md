# OpenCode Tailnet Launcher v0.1.2

## Summary

- Reframed the VPS router as the formal `0.1.2` relayer product, while keeping the launcher stable and narrow.
- Enforced official OpenCode-only operation: no fork, no plugin, no upstream patch dependency.
- Added relayer target typing and admission truth for `launcher-managed` and `attach-only` targets.
- Kept the real browser gate as the final release truth source.

## What Changed

### Official OpenCode compatibility

`v0.1.2` explicitly targets official OpenCode web behavior and isolates compatibility handling inside the relayer rather than inside a forked app.

The launcher-managed machine now relies on the official CLI path only, while the relayer keeps upstream inspection compatible with auth-enabled official builds.

### Target typing

The relayer now distinguishes two target classes:

- `launcher-managed`: the one machine allowed to auto-start the official CLI through the launcher
- `attach-only`: any other Tailscale target that may be inspected and entered if already serving OpenCode web, but is never remotely started or controlled

This turns multi-machine support into an explicit product rule instead of an accidental side effect of `host:port` probing.

### Admission truth

The relayer now reports target admission more explicitly:

- `probe`
- `enter`
- `no-session`
- `launcher-managed-unavailable`
- `attach-only-unavailable`

These states appear through relayer surfaces rather than only through vague loading-page behavior.

### Target-scoped failure budget

The relayer now tracks target-level failure count and backoff timing so repeated failures stop thrashing the same target immediately.

## Validation

Validated with:

- local official CLI baseline returning `200` health and non-empty session list on `100.121.130.36:3000`
- `node .\router-sandbox-check.js` from `D:\CODE\opencode-tailscale`
- live browser gate from `node .\verify-launch-gate.js`

Live browser gate evidence:

- launcher-managed desktop: `ok=true`, `reason=session-route`, `durationMs=5297`
- launcher-managed mobile: `ok=true`, `reason=session-route`, `durationMs=16269`

Live relayer envelope evidence:

- `/__oc/meta` on the live target reports `targetType=launcher-managed`
- `/__oc/meta` on the live target reports `admission=enter`
- `failureCount` and `backoffUntil` are now part of the target envelope

## Notes

- This release keeps the launcher stable and narrow.
- The relayer is now the formal redesign target.
- Browser-gated delivery remains mandatory; syntax and sandbox checks are preflight only.
