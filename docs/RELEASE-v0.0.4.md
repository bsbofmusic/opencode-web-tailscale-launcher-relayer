# OpenCode Tailnet Launcher v0.0.4

## Summary

- Upgraded the VPS router from a passive proxy into a warm-cache entrypoint.
- Added a staged launch progress page so first-time reads explain what the VPS is doing instead of leaving users on a blank wait.
- Cached the recent session index plus the latest session snapshot on the VPS so repeat opens can reuse warm data before the app refreshes the remote state.

## What Changed

### VPS cache warmup

The router now warms a target-specific cache keyed by `host:port`.

Cached data includes:

- remote health summary
- recent session index
- per-directory root session lists
- latest session detail
- recent session message snapshots for the latest workspace

The cache is refreshed with a stale-while-revalidate flow so repeated opens do not pay the same cold-start cost each time.

### Launch progress

`/__oc/launch` now opens a staged progress page that explains the warmup pipeline:

- connect to the remote OpenCode instance
- read the recent session index
- cache recent session snapshots on the VPS
- open the latest session and continue refreshing in the background

### Cached API responses

After warmup, the router can answer these requests directly from the VPS cache when they match the warmed snapshot:

- `GET /session?directory=...&roots=true&limit=55`
- `GET /session/:id`
- `GET /session/:id/message?limit=80|200`

Live cache hits are marked with `X-OC-Cache: hit`.

## Validation

Validated before deployment with:

- a self-contained local sandbox that starts both a mock upstream and the router
- three sequential sandbox passes covering cold start, warm cache reuse, and cached message hits
- a local browser run that verified the launch progress page and automatic redirect
- a public browser run against `https://opencode.cosymart.top/` after deployment
- live `curl` checks confirming `X-OC-Cache: hit` for warmed session list, session detail, and message endpoints

## Notes

- This release improves perceived load time and repeat-open performance, but it does not eliminate every slow path inside the upstream OpenCode app.
- Existing site-level CSP warnings remain outside the router cache change.
- Public config exposure is still a separate hardening task.
