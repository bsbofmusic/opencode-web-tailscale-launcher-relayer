"use strict"
const {execSync} = require("child_process")
const git = (...args) => {
  console.log("$ git", ...args)
  try {
    const out = execSync("git " + [...args].join(" "), {cwd: "D:\\CODE\\opencode-tailscale", encoding: "utf8"})
    console.log(out)
    return out
  } catch(e) {
    console.error(e.stderr || e.message)
    throw e
  }
}
git("config", "user.email", "maxlead@example.com")
git("config", "user.name", "Maxlead")
git("add", "-A")
git("status")
console.log("\n=== COMMIT ===")
git("commit", "-m", `fix(phase1): stabilize session/workspace/state after reopen

Phase 1 state authority unification — fixes 5 regressions at once:
1. state.js syncClientView: remove latest-session fallback overwrite of established activeSessionID/activeDirectory
2. control.js progressPayload: compute launchTarget from query-param activeSession first, not meta.latest
3. watcher.js: never reset client view to meta.sessions.latest; add workspaceMismatch guard in sessionSyncRuntime
4. proxy.js/cache.js/warm.js: synthetic relay:* workspaces display-only, never feed into control-plane latest/sessionIndex
5. pages.js seed(): stop overwriting OpenCode-owned localStorage keys (server, globalSync.project, layout.page, defaultServerUrl)
6. warm.js: fast-path meta from discovery list only, fetchAllWorkspaceRoots pushed to background
7. pages.js sessionSyncRuntime: workspaceMismatch() guard blocks cross-workspace re-enter/soft-refresh
8. watcher tickClientTrackedSession: prefer activeSessionID/activeDirectory first, never fallback to latest global session

Breaks the 'state authority loop' pattern that caused every regression this week.
Breaks the 'cold-start blocks on full workspace scan' pattern that caused 1-2 min load.
Breaks the 'seed overwrites app-owned persistence' pattern that caused composition mode loss on reopen.`)
console.log("\n=== PUSH ===")
try {
  execSync("git push public master", {cwd: "D:\\CODE\\opencode-tailscale", encoding: "utf8"})
  console.log("Pushed to public remote.")
} catch(e) {
  execSync("git push origin master", {cwd: "D:\\CODE\\opencode-tailscale", encoding: "utf8"})
  console.log("Pushed to origin.")
}
console.log("\nAll done.")
