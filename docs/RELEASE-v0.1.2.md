# OpenCode Tailnet Launcher v0.1.2

## Summary

- Reframed the VPS router as the formal `0.1.2` relayer product, while keeping the launcher stable and narrow.
- Enforced official OpenCode-only operation: no fork, no plugin, no upstream patch dependency.
- Added relayer target typing and admission truth for `launcher-managed` and `attach-only` targets.
- Kept the real browser gate as the final release truth source.

## What Changed

### Official OpenCode compatibility

`v0.1.2` explicitly targets official OpenCode web behavior and isolates compatibility handling inside the relayer rather than inside a forked app.

The launcher-managed machine now relies on the official CLI path only, while the relayer keeps upstream inspection and proxy paths aligned with official OpenCode web behavior.

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

### Native session browsing restored

The relayer no longer serves a stale 55-item roots-list fallback for larger session-list requests.

This restores native OpenCode-style session browsing semantics so `Load more` can actually grow the visible list instead of replaying the same warmed snapshot.

## Validation

Validated with:

- local official CLI baseline returning `200` health and non-empty session list on `100.121.130.36:3000`
- `node .\router-sandbox-check.js` from `D:\CODE\opencode-tailscale`
- live browser gate from `node .\verify-launch-gate.js`

Live browser gate evidence:

- attach-only desktop: `ok=true`, `reason=session-route`, `durationMs=8177`
- attach-only mobile: `ok=true`, `reason=session-route`, `durationMs=14084`
- launcher-managed landing-flow desktop: `ok=true`, `reason=session-route`, `durationMs=7459`
- launcher-managed landing-flow mobile: `ok=true`, `reason=session-route`, `durationMs=10086`

The final gate now starts from the public landing page, validates the visible entry controls, triggers the same browser-side `Open` action a human uses, resolves the server-owned launch handoff, and verifies the pinned session route returns valid OpenCode HTML with `<title>OpenCode</title>`, `id="root"`, and the injected `oc-tailnet-sync-runtime` marker.

Live relayer envelope evidence:

- `/__oc/meta` on the live target reports `targetType=launcher-managed`
- `/__oc/meta` on the live target reports `admission=enter`
- `failureCount` and `backoffUntil` are now part of the target envelope

Live truth-surface evidence:

- `/__oc/progress` on the live target reports `targetType=launcher-managed`, `admission=enter`, `launchReady=true`, `failureCount=0`
- `/__oc/healthz` on the live target reports `targetType=launcher-managed`, `admission=enter`, `launchReady=true`, `failureCount=0`

## Notes

- This release keeps the launcher stable and narrow.
- The relayer is now the formal redesign target.
- Browser-gated delivery remains mandatory; syntax and sandbox checks are preflight only.
