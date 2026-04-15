# OpenCode Tailnet Launcher v0.0.9

## Summary

- Restored landing-page target memory so reopening the VPS router no longer forgets the last successful Tailscale host and port.
- Split launch runtime state by client while keeping cache shared by target, reducing cross-tab and cross-browser interference on the same OpenCode target.
- Hardened the relay-only path so `/__oc/progress` stays read-only, light status requests avoid the heavy queue, and deployment now expects upload-then-restart instead of racing both steps.

## What Changed

### Landing target memory recovery

The router landing page now reads the existing `oc_target` cookie again. Reopening `/` will repopulate the last successful target by default unless the user explicitly clears it.

This removes the failure mode where the landing page looked like it had "forgotten" the Tailnet machine even though the router had already stored the target cookie.

### Per-client launch isolation

The router still shares cache and upstream fetch results by `host:port`, but launch-specific state is now scoped by client.

- `launch`, `progress`, and `meta` requests can carry a `client` identifier
- the launch page now propagates that identifier into the final session URL
- different tabs or browsers no longer inherit the same launch warm state by default

This reduces the class of bugs where multiple terminals or browser tabs appeared to share one startup pipeline and would block or overwrite each other.

### Queue and warm-path cleanup

- `/__oc/progress` remains a pure read path and does not re-trigger warm cycles
- lightweight status requests stay off the heavy queue
- slow upstream health conditions continue to reduce snapshot warm work instead of amplifying it

These changes keep the VPS relay from becoming a force multiplier when the upstream OpenCode instance is already slow.

### Deployment workflow correction

This release also corrects an operational pitfall discovered during debugging: uploading a new router file and restarting the service in parallel can leave the VPS process on old code while the disk shows the new file.

The intended deployment workflow is now explicitly sequential:

1. upload the router file
2. restart the router service
3. verify live behavior

## Validation

Validated before and after deployment with:

- local syntax checks for the public router and local runner copies
- updated sandbox runs covering landing target memory, warm timeout recovery, session-HTML timeout fallback, progress read-only behavior, and per-client launch isolation
- live browser verification that reopening `/` repopulates the last target from cookie state
- live header verification that `__oc/launch` now preserves `client` through the redirect URL
- live API verification that one client can warm the target while a second client still observes its own independent launch state

## Notes

- This release keeps the relay-only boundary intact: all fixes live in the VPS router layer and do not patch the upstream OpenCode application.
- The relay now exposes more accurate multi-client behavior, but it still does not and should not attempt to rewrite upstream UI version strings.

## Remaining Risks

- upstream `opencode web` HTML-route instability is still under observation and remains outside the VPS relay's direct control
- the web UI version can still differ from the server version when the upstream frontend bundle and backend service are not aligned
- long-idle renderer crashes such as `STATUS_BREAKPOINT` are still not fully root-caused in this release
