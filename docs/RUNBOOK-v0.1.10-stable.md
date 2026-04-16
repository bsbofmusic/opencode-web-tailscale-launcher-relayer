# Stable 0.1.10 Rollout Runbook

## Baseline
- Known-good runtime: `v0.1.9`
- Frozen browser hot path:
  - `router/pages.js`
  - `router/routes/proxy.js`
  - `router/routes/cache.js`
  - `router/sync/disk-cache.js`

## Conservative timeout recommendation

For VPS environments with Tailscale + reverse proxy in front, prefer:

```bash
OPENCODE_ROUTER_INSPECT_TIMEOUT_MS=8000
OPENCODE_ROUTER_WARM_TIMEOUT_MS=30000
OPENCODE_ROUTER_HTML_TIMEOUT_MS=8000
OPENCODE_ROUTER_RECOVERY_HTML_TIMEOUT_MS=15000
```

Do not tighten `WARM_TIMEOUT_MS` below `30000` unless the deployment has already been load-tested.

## Allowed candidate scope
- `router/index.js`
- `router/routes/control.js`
- `router/warm.js`
- `router/sync/watcher.js`
- docs / verify / rollout assets

## Rollout order
1. Build candidate from the `v0.1.9` base.
2. Deploy to candidate slot only.
3. Run all gates against candidate slot.
4. Observe for 15-30 minutes.
5. Switch traffic only if all gates remain green.
6. Keep the old stable slot intact until the new slot has cleared post-switch observation.

## Mandatory gates
- browser smoke
- fresh browser / incognito gate
- workspace switch
- archive
- message append
- rollback drill
