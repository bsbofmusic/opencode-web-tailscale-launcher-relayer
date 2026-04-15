# VPS Deploy

## Purpose

This guide deploys the public router on a Linux VPS so browsers can enter a remote `opencode web` instance over Tailscale.

The router does three jobs:

1. Accept a public `host:port` target.
2. Inspect the remote OpenCode instance over the tailnet.
3. Seed browser-side project history before redirecting into the real session route.

From `v0.1.2` onward, the router also classifies the target as `launcher-managed` or `attach-only` and reports that admission truth through `progress` and `healthz`.

The public repo now ships the same modular router baseline as the local stable setup: disk cache recovery, background watcher refresh, SSE events, offline-ready cache fallback, and active-session sync all live under `router/` while the entry file path stays `router/vps-opencode-router.js`.

## Prerequisites

- Linux VPS with `systemd`
- `nginx`
- Node.js 18 or newer
- A public domain name pointing at the VPS
- TLS certificate for that domain
- A reachable Tailscale target such as `100.x.x.x:3000`

## Repo Files

- Router entry: `router/vps-opencode-router.js`
- Router modules: `router/**/*.js`
- `systemd` template: `deploy/systemd/opencode-router.service.example`
- `nginx` template: `deploy/nginx/opencode-router.conf.example`

## Suggested Server Paths

- App directory: `/opt/opencode-router`
- Router script: `/opt/opencode-router/router/vps-opencode-router.js`
- `systemd` unit: `/etc/systemd/system/opencode-router.service`
- `nginx` config: `/etc/nginx/conf.d/opencode-router.conf`

## Runtime Settings

The router works with these environment variables:

- `OPENCODE_ROUTER_HOST`: bind address, default `127.0.0.1`
- `OPENCODE_ROUTER_PORT`: bind port, default `33102`
- `OPENCODE_ROUTER_CACHE_DIR`: optional disk cache directory for offline recovery
- `OPENCODE_ROUTER_WATCH_INTERVAL_MS`: optional watcher interval for background refresh and SSE updates
- `OPENCODE_ROUTER_LAUNCHER_HOSTS`: comma-separated list of target hosts that are allowed to be launcher-managed

The provided templates already use those defaults.

`v0.1.2` does not add a new external runtime file to deploy. The session sync runtime is injected inline into session HTML by the router itself.

## Deploy Steps

1. Install Node.js 18+ and `nginx` on the VPS.
2. Create the router app directory.
3. Copy the whole `router/` directory into `/opt/opencode-router/router/`.
4. Copy `deploy/systemd/opencode-router.service.example` to `/etc/systemd/system/opencode-router.service`.
5. Copy `deploy/nginx/opencode-router.conf.example` to `/etc/nginx/conf.d/opencode-router.conf`.
6. Replace every `your-domain.example.com` placeholder in the nginx file.
7. Confirm the TLS certificate paths in the nginx file are correct.
8. Reload `systemd`, enable the router service, and restart `nginx`.

## Example Commands

Run these from a checkout of this repo on the VPS:

```bash
sudo mkdir -p /opt/opencode-router
sudo mkdir -p /opt/opencode-router/router
sudo cp -R router/. /opt/opencode-router/router/
sudo cp deploy/systemd/opencode-router.service.example /etc/systemd/system/opencode-router.service
sudo cp deploy/nginx/opencode-router.conf.example /etc/nginx/conf.d/opencode-router.conf
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-router.service
sudo nginx -t
sudo systemctl reload nginx
```

## Verify

Check the local router process:

```bash
sudo systemctl status opencode-router.service
curl http://127.0.0.1:33102/
```

Check the public endpoint:

```bash
curl -I https://your-domain.example.com/
```

Expected result:

- `opencode-router.service` is `active (running)`
- `http://127.0.0.1:33102/` returns HTML
- the public domain answers over HTTPS

These checks are only preflight. They do not prove the browser exits the launch gate.

## Pre-Ship Gate

Do not ship based only on `curl`, `node --check`, or sandbox output.

The hard gate is a real browser run against the live VPS route.

Prerequisite on the machine running the gate:

- Node.js
- Playwright available either as an installed Node module or through `PLAYWRIGHT_NODE_PATH`
- Chromium installed for Playwright, for example `npx playwright install chromium`

Run from the public repo root:

```powershell
$env:TAILNET_ROUTER_URL="https://your-domain.example.com"
$env:TAILNET_TARGET_HOST="100.x.x.x"
$env:TAILNET_TARGET_PORT="3000"
$env:TAILNET_VERIFY_PROFILES="desktop,mobile"
node .\verify-launch-gate.js
```

```bash
export TAILNET_ROUTER_URL="https://your-domain.example.com"
export TAILNET_TARGET_HOST="100.x.x.x"
export TAILNET_TARGET_PORT="3000"
export TAILNET_VERIFY_PROFILES="desktop,mobile"
node ./verify-launch-gate.js
```

The command must exit `0` on both profiles before release.
The gate now begins at the public landing page, verifies the visible entry controls, triggers the same `Open` action a human uses, resolves the server-owned entry handoff, and proves that the pinned session route returns valid OpenCode HTML.

For local debugging only, you may temporarily run a single profile by adding `TAILNET_REQUIRE_BOTH_PROFILES=0`.

Hard failure conditions:

- the browser stays on `/__oc/launch` beyond the gate timeout
- the browser falls into a `stuck-progress-loop` where `/__oc/progress` keeps returning `200` but the page never leaves launch
- the page never reaches a `/session/` route
- the page resolves into `attach-only-unavailable` or `launcher-managed-unavailable` for a target that should have been enterable
- the launch page ends in `Target is online but has no historical sessions`
- the launch page ends in timeout or warm-failed state

Evidence is written to the OS temp directory unless `TAILNET_EVIDENCE_DIR` is set.

If Playwright is installed in a non-standard location, set:

```powershell
$env:PLAYWRIGHT_NODE_PATH="C:\path\to\node_modules\playwright"
```

The gate now expects a positive success marker in the final page body by default (`Tailnet live`). Override only when debugging or adapting the gate to a different confirmed marker:

```powershell
$env:TAILNET_EXPECT_BODY_REGEX="OpenCode|Tailnet live"
```

## 0.1.2 Sync Verify

Check the session route headers:

```bash
curl -s -D - -o /dev/null "https://your-domain.example.com/<encoded-dir>/session/<session-id>?host=100.x.x.x&port=3000"
```

Expected additional headers on session HTML responses:

- `X-OC-Relay-Sync-State`
- `X-OC-Relay-Action`

Check multi-terminal sync behavior:

1. Open one session through the router.
2. Advance the same session from another terminal.
3. Confirm the open page shows relay-owned sync state instead of silently drifting.
4. Confirm `/__oc/healthz` exposes stale or protected client counts when applicable.

For `v0.1.2`, also confirm the relayer surfaces target typing clearly:

1. `progress.targetType` is present.
2. `progress.admission` is present.
3. `healthz.states[*].targetType` and `healthz.states[*].admission` match the expected target policy.

## 0.1.4 Workspace And Chip Verify

After deploy, also verify these user-facing outcomes:

1. From the landing page, opening the target still reaches the session page normally.
2. Multiple workspace roots can be surfaced in the project rail (for example `D:\CODE` and `E:\CODE`).
3. Switching to another workspace changes the visible session list accordingly.
4. The Tailnet status chip is not shown during normal `live` state, so it does not obstruct the search or header area.

This section is secondary. The release gate comes first: if `verify-launch-gate.js` fails, the build is not shippable even if headers and sync state endpoints look healthy.

## Typical Flow

1. Open `https://your-domain.example.com/`.
2. If you open the public router manually, enter the Tailscale IPv4 and port for the Windows machine running the launcher.
3. If you open from the Windows launcher, it injects the current host and port into `router_url` automatically and examples default to `autogo=1`.
4. Click `Check` to confirm the target is healthy.
5. Click `Open Remote OpenCode` to seed history and jump into the latest session.

## Troubleshooting

### Landing Page Works But Check Fails

- Verify the remote machine is online in Tailscale.
- Verify `opencode web` is listening on the configured port.
- Test from the VPS with `curl http://100.x.x.x:3000/global/health`.

### Nginx Returns 502

- Check `sudo systemctl status opencode-router.service`.
- Check `journalctl -u opencode-router.service -n 100 --no-pager`.
- Confirm the router is listening on `127.0.0.1:33102`.

### Browser Opens OpenCode But History Is Missing

- Use the router entrypoint, not the raw remote `100.x.x.x:3000` URL.
- Confirm the browser is same-origin with the router domain.
- Confirm `/__oc/meta` returns directories and a latest session.
