# OpenCode Tailnet Launcher & Relayer

## 5W What/Why/How/Who/When

### What
A portable Windows launcher + VPS relayer that bridges your local browser to remote OpenCode Web via Tailscale, without modifying OpenCode itself.

### Why
OpenCode Tailnet Launcher runs as a system tray app on Windows, keeping OpenCode alive.  
The Relayer runs on a VPS (Ubuntu/Tailscale) and forwards browser traffic to your private network OpenCode instance — no public exposure, no auth config, no DNS.  
Your browser talks to the relayer. The relayer talks to your private OpenCode. You get native OpenCode Web experience anywhere.

### How

```
Browser (HTTPS public) 
  → VPS Relayer (nginx :443) 
    → Tailscale tunnel (:3000) 
      → OpenCode Web (:3000 private)
```

### Who
- **Launcher**: Windows users who want one-click remote access via Tailscale
- **Relayer**: Linux VPS with Tailscale, node 18+, no OpenCode installation needed

### When
- Launch the launcher on Windows
- The relayer is always running on VPS
- Open browser → see your remote OpenCode

---

## Project Structure

```
opencode-tailscale/
├── launcher/          Windows tray app source
├── router/           VPS relayer (Node.js)
│   ├── routes/       HTTP route handlers (proxy, cache, control)
│   ├── sync/         Watcher + disk-cache
│   └── pages.js       Injected browser JS runtime
├── README.md         This file
└── opencode-router.service  systemd unit for VPS
```

---

## Phase 1 Fixes (2026-04-13) — Stability Update

### What was wrong
Multiple regressions on second-open: workspace switch rollback, session loss, composition mode missing, slow load, dark status.

### Root cause
Four relayer layers were simultaneously owning the same state with no single authority:
1. Browser `localStorage` was being overwritten by relayer `seed()`
2. `syncClientView()` reset active session to latest on every tick
3. `progressPayload()` used `meta.latest` as launch target instead of browser-reported active session
4. Watcher rebuilt `meta.sessions.latest` from synthetic workspace entries
5. `warm()` blocked launch on full workspace scan

### What was fixed

| # | File | Fix |
|---|------|-----|
| 1 | `state.js` `syncClientView()` | Remove fallback that overwrote established `activeSessionID/activeDirectory` with `meta.latest` |
| 2 | `control.js` `progressPayload()` | `launchTarget` computed from query-param active session first; `syncClientView` moved after |
| 3 | `watcher.js` `tickWatcher()` | Never writes `client.view`/`activeSessionID`/`activeDirectory`; synthetic workspace guarding |
| 4 | `pages.js` `sessionSyncRuntime()` | `workspaceMismatch()` guard blocks cross-workspace `re-enter`/`soft-refresh` |
| 5 | `proxy.js`/`cache.js` | Synthetic `relay:*` workspaces are display-only, never enter control-plane `latest`/`roots` |
| 6 | `warm.js` | Fast-path meta from discovery list; `fetchAllWorkspaceRoots` → background; `latest` computed from discovery first |
| 7 | `pages.js` `seed()` | Stopped writing OpenCode-owned localStorage keys (`server`, `globalSync.project`, `layout.page`, `defaultServerUrl`) |

### What was NOT modified
- No changes to OpenCode source
- No changes to Tailscale configuration
- No changes to nginx upstream contract
- Launcher is unchanged

---

## Upgrade History

### v0.1.4 (2026-04-13) — Phase 1 Stability
- Workspace switch stability on second-open
- Session persistence across tab reopens
- Cold-start fast-path (no longer waits for all workspace scans)
- OpenCode-owned localStorage preserved on relaunch
- Relayer module-only change, no OpenCode modification

### v0.1.3 — Workspace Support
- Synthetic `relay:*` workspace injection for extra roots
- Launcher auto-detect of workspace roots

### v0.1.2 — Relayer Initial
- VPS relayer with Tailscale proxy
- Session persistence, warm cache, watcher background sync
- Browser runtime injection

### v0.1.0 — Launcher Initial
- Windows tray app
- Tailscale auth key management
- Auto-restart on network change
