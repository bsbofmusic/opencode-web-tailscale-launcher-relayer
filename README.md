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
- Active-session sync on the already-open session page
- Inline router-owned sync runtime injected into session HTML only
- Safe sync actions: `noop`, `soft-refresh`, `defer`, `re-enter`
- Multi-target relayer model with `launcher-managed` and `attach-only` targets
- Modular router runtime with disk-backed cache recovery, background watch refresh, SSE progress/events, and offline-ready fallback behavior

## Architecture

1. `OpenCodeTailnetLauncher.exe` runs on a Windows machine already inside your tailnet.
2. The launcher detects the machine's current `100.x.x.x` Tailscale address.
3. If `opencode web` is missing or unhealthy on the launcher-managed machine, it starts it again with the configured port and CORS origin.
4. A VPS-hosted router receives public browser traffic.
5. The router probes the remote OpenCode server, classifies the target as `launcher-managed` or `attach-only`, reads the latest sessions, writes the required browser-side project state, and redirects into the exact session route.
6. After that handoff, the router continues to coordinate active-session freshness through router-side state, SSE events, and session-page sync actions.

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
6. The launcher injects the current Tailscale `host` and configured `port` into `router_url` automatically, and keeps `autogo=1` unless you override it.

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
- `router_url`: page opened when you double-click the tray icon; the launcher appends the current `host` and `port` automatically and defaults examples to `autogo=1`
- `poll_seconds`: health-check interval

See `launcher/oc-launcher.ini.example` for the template.

## VPS Router

The router is designed to sit behind `nginx` and a public hostname.

The public router now uses the same modular final-experience baseline as the local stable build: disk cache recovery, background watcher refresh, SSE progress/events, launch-time state seeding, offline-ready cache fallback, transparent proxy handoff, and active-session sync all live under `router/` while the public entry file path stays `router/vps-opencode-router.js`.

Core routes:

- `GET /`: landing page for entering `host:port`
- `GET /__oc/meta`: remote health and session inspection
- `GET /__oc/launch`: pre-seed browser state then redirect to the exact remote session
- `GET /__oc/events`: SSE stream for target health and cache/session changes
- `GET /__oc/healthz`: lightweight router/cache health summary
- all other paths: proxied through to the remote OpenCode web server

The relayer owns target typing. A `launcher-managed` target is the one machine allowed to auto-start the official CLI through the launcher. An `attach-only` target can be probed and entered if already serving OpenCode web, but is never remotely started or controlled.

This is what fixes the common first-load problem where a fresh browser or mobile device does not show historical sessions.

From `v0.1.1` onward, the router also closes the post-launch stale-page gap: it can mark the current session page stale, choose a safe action, and keep the open page aligned without patching upstream `opencode`.

## VPS Deployment

Use the templates in:

- `deploy/systemd/opencode-router.service.example`
- `deploy/nginx/opencode-router.conf.example`

Detailed steps are in `docs/DEPLOY_VPS.md`.

The nginx example proxies `/` to the router landing page and forwards every other request to the same local router service.

Pre-ship rule: do not treat syntax checks and sandbox checks as release evidence by themselves. The release gate is a real browser run through `node .\verify-launch-gate.js` against the live router URL and target host, and it must pass for both `desktop` and `mobile`.

If Playwright is not resolvable from the current Node environment, provide `PLAYWRIGHT_NODE_PATH` to the installed Playwright module path.
Install the Chromium browser for Playwright before using the gate.

## Build

The Windows launcher build uses the built-in .NET Framework C# compiler on Windows.

```powershell
powershell -ExecutionPolicy Bypass -File .\launcher\build-oc-launcher.ps1
```

That build produces:

- `launcher\dist\OpenCodeTailnetLauncher.exe`
- `launcher\dist\OpenCodeTailnetLauncher-v0.1.2-single.zip`

## Security

- This repo does not contain real VPS credentials
- This repo uses example hostnames and example paths only
- Do not commit real SSH passwords, real domains, or real certificate files
- If a GitHub token was ever exposed during setup, revoke it and create a new one before continuing maintenance

## License

This project is released under the MIT License. See `LICENSE`.

## Release

Current version:

- `v0.1.2`

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
- `docs/RELEASE-v0.0.12.md`: public sync to the modular final-experience baseline with launcher host/port injection and autogo defaults
- `docs/RELEASE-v0.1.1.md`: relay-only active-session sync with inline session runtime and router-owned sync actions
- `docs/RELEASE-v0.1.2.md`: official-OpenCode-only relayer with target typing, admission states, and browser-gated delivery
