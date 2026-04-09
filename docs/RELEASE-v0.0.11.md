# OpenCode Tailnet Launcher v0.0.11

## Summary

- Restored a fast normal launch path while keeping the relay-only recovery path for genuinely risky sessions.
- Extended freshness protection so both the latest session and the client’s currently active session stop serving stale `limit=80` message pages.
- Completed the relay diagnostics surface with mode/reason headers and stronger `healthz` visibility, while fixing router self-crash paths discovered during stabilization.

## What Changed

### Fast-path launch versus protected launch

The relay now keeps two distinct entry modes:

- a fast path for normal cold launch
- a protected path for idle recovery, PTY activity, or other high-risk conditions

This avoids charging every normal launch for recovery-only safeguards while preserving the existing relay protections when the target is in a fragile state.

### Active-session freshness for recent messages

The relay already stopped reusing stale cache for the latest session’s recent messages. This release extends the same protection to whichever session the current client has actively opened.

- latest-session `limit=80` message reads bypass stale cache
- active-session `limit=80` message reads also bypass stale cache
- paginated history requests still behave as normal proxy traffic

This reduces the odds that desktop and mobile clients will appear to disagree about the visible head of the same conversation.

### Idle and terminal protection without self-amplification

The idle-recovery and PTY-aware safeguards remain relay-only, but the recovery scheduler no longer recurses into `pumpBackground()` / `drainHeavy()` until the router crashes.

The relay now:

- pauses background warm work while PTY traffic is active
- pauses background warm work during the idle recovery window
- resumes safely without recursive self-triggered crashes

### Diagnostics that explain relay behavior

This release standardizes the relay response surface:

- `X-OC-Relay-Priority`
- `X-OC-Relay-Mode`
- `X-OC-Relay-Reason`

`healthz` also exposes the relay’s current protection state and last observed reason, so operators can distinguish between cache hits, freshness bypasses, fallback pages, and upstream failures without touching the upstream OpenCode app.

## Validation

Validated before and after deployment with:

- fresh local syntax checks for the public router and local runner copies
- full sandbox regression runs covering launch, cache hit safety, latest/active freshness bypass, history priority, HTML timeout fallback, idle-targeted behavior, terminal-targeted behavior, and diagnostics headers
- live verification that warm-then-launch returns a `302` with `X-OC-Relay-Mode: control` and `X-OC-Relay-Reason: launch-redirect`
- live verification that latest-session and active-session `limit=80` message requests now expose `bypass` semantics with the correct relay reason
- live `healthz` verification that the relay reports current protection state rather than failing silently

## Notes

- This release remains strictly relay-only. It does not modify upstream OpenCode code, protocols, or UI bundles.
- Manual history replay remains supported; the relay changes prioritization and freshness rules, not the upstream session model.

## Remaining Risks

- upstream frontend/backend version mismatches still remain outside the relay’s direct control
- `STATUS_BREAKPOINT`-style browser crashes can be mitigated by the relay but not fully rooted out without upstream changes
- true strong realtime consistency across terminals remains bounded by upstream protocol semantics; the relay currently provides a near-realtime, safer consistency layer rather than absolute synchronization
