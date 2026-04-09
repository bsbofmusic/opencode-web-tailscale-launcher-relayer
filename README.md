# OpenCode Tailnet Launcher

OpenCode Tailnet Launcher is a small two-part setup for accessing remote `opencode web` over Tailscale with minimal friction.

- Windows side: a silent tray launcher keeps `opencode web` healthy
- VPS side: a lightweight router inspects remote sessions, seeds browser state, and redirects into the exact session page

The result is a mobile-friendly public entrypoint that does not need the OpenCode desktop app, does not depend on stale browser cache, and does not pop open browsers while you work.

## Features

- Silent Windows tray app
- Single-exe portable runtime for the launcher
- No automatic browser popups
- Auto-detects the current Tailscale IPv4
- Keeps `opencode web` healthy on the configured port
- Router pre-seeds same-origin OpenCode history before redirecting
- Transparent proxy after entering the real OpenCode page

## Architecture

1. `OpenCodeTailnetLauncher.exe` runs on a Windows machine already inside your tailnet.
2. The launcher detects the machine's current `100.x.x.x` Tailscale address.
3. If `opencode web` is missing or unhealthy, it starts it again with the configured port and CORS origin.
4. A VPS-hosted router receives public browser traffic.
5. The router probes the remote OpenCode server, reads the latest sessions, writes the required browser-side project state, and redirects into the exact session route.
6. After that handoff, the router behaves as a transparent proxy.

## Repo Layout

- `launcher/`: Windows tray launcher source and build scripts
- `router/`: Node-based VPS router source
- `deploy/`: example `systemd` and `nginx` configs
- `docs/`: release notes and VPS deployment notes

## Requirements

- Windows machine already joined to Tailscale
- OpenCode CLI installed on that Windows machine
- VPS with Node.js 18+ and `nginx`
- Public domain name for the router
- TLS certificate on the VPS

## Quick Start

### Windows Launcher

1. Build the launcher from `launcher/` or download the release asset.
2. Run `OpenCodeTailnetLauncher.exe`.
3. It stays in the tray and does not open the browser by itself.
4. On first run it generates `oc-launcher.ini` beside the exe.
5. Double-click the tray icon if you want to open the router page manually.

### Autostart

```powershell
OpenCodeTailnetLauncher.exe --install-autostart
OpenCodeTailnetLauncher.exe --remove-autostart
```

## Launcher Behavior

The launcher is intentionally quiet.

- No startup window
- No automatic browser launch
- No mandatory installer
- No background Electron or Node runtime

Tray status colors:

- Green: `running`
- Blue: `starting`
- Orange: `waiting`
- Red: `error`

Generated files after first run:

- `oc-launcher.ini`
- `logs\launcher.log`

## Configuration

The launcher writes `oc-launcher.ini` automatically if it does not exist.

Important keys:

- `cli_path`: path to `opencode.cmd` or another compatible binary
- `port`: local OpenCode web port, default `3000`
- `cors_origin`: public router origin that should be allowed by OpenCode web
- `router_url`: page opened when you double-click the tray icon
- `poll_seconds`: health-check interval

See `launcher/oc-launcher.ini.example` for the template.

## VPS Router

The router is designed to sit behind `nginx` and a public hostname.

In `v0.0.8`, the router keeps the asynchronous cache layer from `v0.0.7` but hardens the real entry path around it: launch can now fall back to a server-side redirect into the latest known session, cache state no longer gets stuck in a false busy state, and the example nginx config now hides upstream CSP headers that were breaking session loads in the public proxy path.

Core routes:

- `GET /`: landing page for entering `host:port`
- `GET /__oc/meta`: remote health and session inspection
- `GET /__oc/launch`: pre-seed browser state then redirect to the exact remote session
- `GET /__oc/healthz`: lightweight router/cache health summary
- all other paths: proxied through to the remote OpenCode web server

This is what fixes the common first-load problem where a fresh browser or mobile device does not show historical sessions.

## VPS Deployment

Use the templates in:

- `deploy/systemd/opencode-router.service.example`
- `deploy/nginx/opencode-router.conf.example`

Detailed steps are in `docs/DEPLOY_VPS.md`.

The nginx example proxies `/` to the router landing page and forwards every other request to the same local router service.

## Build

The Windows launcher build uses the built-in .NET Framework C# compiler on Windows.

```powershell
powershell -ExecutionPolicy Bypass -File .\launcher\build-oc-launcher.ps1
```

That build produces:

- `launcher\dist\OpenCodeTailnetLauncher.exe`
- `launcher\dist\OpenCodeTailnetLauncher-v0.01-single.zip`

## Security

- This repo does not contain real VPS credentials
- This repo uses example hostnames and example paths only
- Do not commit real SSH passwords, real domains, or real certificate files
- If a GitHub token was ever exposed during setup, revoke it and create a new one before continuing maintenance

## License

This project is released under the MIT License. See `LICENSE`.

## Release

Current version:

- `v0.0.11`

Release notes:

- `docs/RELEASE-v0.01.md`: initial launcher and router release
- `docs/RELEASE-v0.02.md`: initial router directory-context hardening release
- `docs/RELEASE-v0.02.1.md`: hotfix for the `v0.02` session-entry regression
- `docs/RELEASE-v0.0.3.md`: router protocol reset with launch-time state seeding and sandbox-verified recovery
- `docs/RELEASE-v0.0.4.md`: VPS cache warmup with staged launch progress and cached session snapshots
- `docs/RELEASE-v0.0.5.md`: mobile stability pass with upstream keep-alive, heavy-request throttling, and gzip transport tuning
- `docs/RELEASE-v0.0.6.md`: launch-state hotfix so stale cache can open immediately during background refresh
- `docs/RELEASE-v0.0.7.md`: asynchronous background caching with non-blocking launch and router health summary
- `docs/RELEASE-v0.0.8.md`: launch/session access hardening with server-side redirect fallback, cache-state recovery, and proxy CSP cleanup
- `docs/RELEASE-v0.0.9.md`: relay-only hardening for landing memory, per-client launch isolation, and safer multi-terminal behavior
- `docs/RELEASE-v0.0.10.md`: relay-only history replay protection with background old-history deprioritization and improved priority observability
- `docs/RELEASE-v0.0.11.md`: relay-only stabilization pass for fast-path launch, active-session freshness, idle/terminal protection, and response diagnostics
