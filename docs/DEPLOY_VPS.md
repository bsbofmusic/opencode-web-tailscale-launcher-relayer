# VPS Deploy

## Purpose

This guide deploys the public router on a Linux VPS so browsers can enter a remote `opencode web` instance over Tailscale.

The router does three jobs:

1. Accept a public `host:port` target.
2. Inspect the remote OpenCode instance over the tailnet.
3. Seed browser-side project history before redirecting into the real session route.

The public repo now ships the same modular router baseline as the local stable setup: disk cache recovery, background watcher refresh, SSE events, and offline-ready cache fallback all live under `router/` while the entry file path stays `router/vps-opencode-router.js`.

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

The provided templates already use those defaults.

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
curl http://127.0.0.1:33102/__landing
```

Check the public endpoint:

```bash
curl -I https://your-domain.example.com/
```

Expected result:

- `opencode-router.service` is `active (running)`
- `http://127.0.0.1:33102/__landing` returns HTML
- the public domain answers over HTTPS

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
