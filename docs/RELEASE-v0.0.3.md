# OpenCode Tailnet Launcher v0.0.3

## Summary

- Replaced the `v0.02` browser-directory compatibility layer with a launch-time seed that matches OpenCode's native web routing.
- Removed the global HTML bootstrap injection so the router stops racing the frontend's own bootstrap flow.
- Added short-lived router-side inspect caching so repeat launch checks do not re-scan health and sessions on every request.

## Router Flow

- `GET /__oc/meta` inspects the remote OpenCode target and memoizes the result briefly.
- `GET /__oc/launch` writes `opencode.settings.dat:defaultServerUrl` and `opencode.global.dat:server`, then redirects to `/{base64(directory)}/session/{id}`.
- All app traffic after launch stays on the normal OpenCode web entrypoint and goes through a transparent HTTP/WebSocket proxy.

## Validation

- Verified in a self-contained local sandbox that starts a mock upstream plus the router, then checks session launch, storage seeding, cache reuse, manifest handling, and proxy behavior.
- Re-ran the sandbox validation three times sequentially before deploying.
- Verified the public router can resolve `__oc/meta` and land in a real restored session route after deployment.

## Notes

- Windows launcher behavior is unchanged.
- This release does not solve site-level CSP warnings emitted by the hosted web bundle or Cloudflare scripts.
- Public `/global/config` exposure is still a separate security problem and should be tightened in a follow-up change.
