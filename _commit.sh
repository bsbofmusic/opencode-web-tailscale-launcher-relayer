#!/bin/bash
set -e
cd "$(dirname "$0")"
git add -A
echo "Staged files:"
git diff --cached --stat
echo ""
echo "Committing Phase 1 fixes..."
git config user.email "maxlead@example.com" 2>/dev/null || true
git config user.name "Maxlead" 2>/dev/null || true
git commit -m "fix(phase1): stabilize session/workspace/state after reopen

Phase 1 state authority unification — fixes 5 regressions at once:
1. state.js syncClientView: remove latest-session fallback overwrite of established activeSessionID/activeDirectory
2. control.js progressPayload: compute launchTarget from query-param activeSession first, not meta.latest
3. watcher.js: never reset client view to meta.sessions.latest; add workspaceMismatch guard in sessionSyncRuntime
4. proxy.js/cache.js/warm.js: synthetic relay:* workspaces display-only, never feed into control-plane latest/sessionIndex
5. pages.js seed(): stop overwriting OpenCode-owned localStorage keys (server, globalSync.project, layout.page, defaultServerUrl)
6. warm.js: fast-path meta from discovery list only, fetchAllWorkspaceRoots pushed to background

Plus:
- pages.js sessionSyncRuntime: workspaceMismatch() guard blocks cross-workspace re-enter/soft-refresh
- watcher tickClientTrackedSession: prefer activeSessionID/activeDirectory first, never fallback to latest global session
- warm.js: FAST/PHASE1 fastMeta logic gates workspace scan behind background fetch

Breaks the 'state authority loop' pattern that caused every regression this week.
Breaks the 'cold-start blocks on full workspace scan' pattern that caused 1-2 min load.
Breaks the 'seed overwrites app-owned persistence' pattern that caused composition mode loss on reopen."
echo "Committed."
echo "Pushing to remote..."
git push public master 2>&1 || git push origin master
echo "Done."
