# OpenCode Tailnet Launcher v0.0.10

## Summary

- Protected manual history replay by deprioritizing background old-history prefetch in the VPS relay instead of changing OpenCode itself.
- Added relay-priority observability so foreground versus background message-page traffic can be diagnosed directly from responses.
- Tightened the active-session tracking logic so failed HTML session opens do not poison later message prioritization.

## What Changed

### Foreground versus background history routing

The VPS relay now treats old-history message pages differently depending on whether the request belongs to the client’s active session or to a different session being prefetched in the background.

- current-session history replay keeps foreground priority
- cross-session `message?limit=200` requests are treated as background
- background heavy traffic can no longer compete on equal footing with manual history replay

This keeps the relay from turning sidebar or neighbor-session prefetch into a bottleneck for the user’s explicit history navigation.

### Priority observability on both proxy and cache hits

The relay now attaches `X-OC-Relay-Priority` headers consistently so traffic classification is visible even when cached responses are served.

This makes it possible to tell whether a slow history request came from the foreground user path or from a background prefetch path without instrumenting the upstream OpenCode app.

### Safer active-session tracking

The relay now updates the client’s active session only after the HTML session route has actually succeeded. Failed or timed-out HTML navigations no longer leave the client tagged against the wrong session, which previously risked inverting later foreground/background message prioritization.

## Validation

Validated before and after deployment with:

- local syntax checks for the public router and local runner copies
- updated sandbox coverage for background old-history stalls, manual history replay preservation, cached priority headers, and failed HTML navigation recovery
- live verification that foreground and background `message?limit=200` requests now expose different `X-OC-Relay-Priority` headers
- live health checks confirming the router still returns healthy target state after the priority changes

## Notes

- This release stays strictly within the relay-only boundary and does not alter OpenCode’s upstream history-loading behavior.
- Manual history replay remains supported; the relay only changes queue priority and diagnostics around competing background work.

## Remaining Risks

- upstream payload size and HTML-route instability remain outside the relay’s direct control
- current-session automatic history expansion inside the upstream app is still treated as foreground because the relay cannot reliably distinguish it from user-driven replay without upstream signals
- long-idle renderer crashes and frontend/backend version mismatches still require separate follow-up work
