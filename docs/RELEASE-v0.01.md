# OpenCode Tailnet Launcher v0.01

## Summary

- Silent Windows tray launcher for `opencode web`
- No automatic browser popups
- Auto-detects current Tailscale IPv4
- Keeps `opencode web` healthy on the configured port
- Supports exact same-origin history pre-seed flow through the VPS router
- Single-exe portable release

## Tray States

- Green: `running`
- Blue: `starting`
- Orange: `waiting`
- Red: `error`

## Notes

- The launcher never opens the browser by itself.
- Double-clicking the tray icon opens the router page.
- If `oc-launcher.ini` is missing, the exe creates it automatically with defaults.
