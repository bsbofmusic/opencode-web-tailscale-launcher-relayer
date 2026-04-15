# OpenCode Tailnet Launcher v0.01

## Summary

- Silent Windows tray launcher for `opencode web`
- No automatic browser popups
- Auto-detects current Tailscale IPv4
- Keeps `opencode web` healthy on the configured port
- Supports exact same-origin history pre-seed flow through `https://opencode.cosymart.top/`
- Single-exe portable release

## Files

- Release artifact: `OpenCodeTailnetLauncher.exe`
- Portable archive: `OpenCodeTailnetLauncher-v0.01-single.zip`
- Generated after first run: `oc-launcher.ini`, `logs\launcher.log`

## Tray States

- Green: `running`
- Blue: `starting`
- Orange: `waiting`
- Red: `error`

## Commands

```powershell
OpenCodeTailnetLauncher.exe --install-autostart
OpenCodeTailnetLauncher.exe --remove-autostart
```

## Notes

- The launcher never opens the browser by itself.
- Double-clicking the tray icon opens the router page.
- Logs are written under `logs\launcher.log` beside the exe.
- If `oc-launcher.ini` is missing, the exe creates it automatically with defaults.
