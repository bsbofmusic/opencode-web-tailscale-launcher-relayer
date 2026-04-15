# OpenCode Tailnet Launcher v0.0.8

## Summary

- Hardened the VPS router so launch can recover through a server-side redirect instead of depending entirely on the browser loading page.
- Fixed warm/cache state handling that could leave launch stuck in a false refreshing state.
- Added timeout recovery for hung warm cycles and a recoverable fallback page when the proxied session HTML route stalls.
- Updated the nginx example to hide upstream CSP headers that were breaking the proxied session page.

## What Changed

### Launch recovery and direct session handoff

The router now tries to resolve the latest launch target on the server before returning the loading page. If the latest session is already known, `GET /__oc/launch` can hand the browser straight into the session route instead of waiting for client-side polling to do the redirect.

This makes the public entry path more resilient when the loading page is retried aggressively or when browser-side launch state is interrupted.

### Warm-state self-healing

- tightened `warm` / `refreshing` state transitions
- added background-job deduplication so repeated snapshot work does not pile up
- prevented non-2xx upstream responses from being stored as reusable cache entries
- improved health reporting so false-busy states are easier to spot
- added warm timeout recovery so stale metadata can survive a hung refresh path

These changes target the class of failures where launch appeared to be refreshing forever even though no real work was still running.

### Session HTML timeout fallback

The router now treats the proxied session HTML route as a separate failure domain from the JSON APIs behind it.

- hung session HTML requests no longer wait forever
- the router returns a recoverable timeout page instead of leaving the browser in an indefinite pending state
- router health output now exposes promise age so a stuck warm path is visible immediately

### Proxy CSP cleanup

The nginx example now hides proxied `Content-Security-Policy` headers. This avoids a session-page failure mode where upstream CSP blocked inline startup scripts and extra requests after the user had already been redirected into OpenCode.

## Validation

Validated before and after deployment with:

- local syntax checks
- updated sandbox runs covering direct launch redirect, warm-timeout recovery, and session-HTML timeout fallback
- live browser verification of `__oc/launch` -> session navigation
- live header checks confirming the proxied session response no longer exposes the broken CSP header
- live console checks confirming the recovered entry path loads without the prior launch-page script failure
- live curl checks confirming the session HTML route now returns a bounded response instead of hanging with no first byte

## Notes

- This release intentionally prefers a slightly slower cold start over brittle fast-path behavior.
- The remaining tradeoff is that cold launch may wait a bit longer while the VPS confirms the latest known session before redirecting.

## Remaining Risks

- upstream `opencode web` HTML-route instability is still under observation and may vary by upstream version
- long-idle renderer crashes such as `STATUS_BREAKPOINT` are not fully root-caused in this release
- launch re-entry and aggressive stress behavior are improved, but still need a dedicated follow-up hardening pass
