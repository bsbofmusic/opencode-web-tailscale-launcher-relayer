# OpenCode Tailnet Launcher v0.02

## Summary

- Hardened the VPS router so redirected requests keep the correct OpenCode directory context.
- Fixed the common restore failure where a historical session opened as a blank board.
- Fixed redirected sessions losing their model state and falling back to `Select model`.
- Improved remote workspace and file-area refresh consistency after entering a restored session.

## What Changed

- The router now persists the latest detected session directory in an `oc_directory` cookie.
- `__oc/launch` now redirects with an explicit `directory` query instead of relying on an encoded path segment.
- Proxied upstream requests now forward directory context through:
  - `x-opencode-directory`
  - `directory` query propagation on rewritten redirects

## Scope

- Windows launcher behavior is unchanged in `v0.02`.
- This release is focused on VPS router correctness and session restore stability.

## Notes

- Existing deployments should update the VPS router script and restart `opencode-router.service`.
- If a browser still shows stale state after upgrade, refresh once or reopen the router entrypoint so the new directory cookie is written.
