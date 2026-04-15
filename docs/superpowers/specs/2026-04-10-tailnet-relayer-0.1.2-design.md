# Tailnet Relayer 0.1.2 Design

**Status:** Draft

**Goal:** Redefine `0.1.2` as a relay-only, official-OpenCode-compatible relayer release that supports multi-target machines, preserves the stable launcher boundary, and turns remote OpenCode access into a product that can actually be shipped and verified.

**One-line definition:** `0.1.2` is a Persistent Relayer centered on the VPS: it discovers target machines by Tailscale IP, decides whether they are attach-only or launcher-managed, warms and routes into the right session, and keeps the open page usable without forking, patching, or plugin-extending upstream `opencode`.

## Product Definition

This product is not a modified OpenCode and not a second OpenCode distribution.

It is a two-layer system built around official OpenCode:

- the **launcher** is the local host-and-port binder and process keeper on the one machine that is allowed to auto-start the official CLI
- the **relayer** is the VPS-side remote entry and session coordinator for all supported machines

The relayer is the actual product focus in `0.1.2`.

What the user should feel:

- they can open a public router URL, enter a Tailscale IP, and get a clear result instead of guesswork
- if the target is a launcher-managed machine, the system can make sure official `opencode web` is available there
- if the target is an attach-only machine, the system can connect and read sessions without trying to control that machine
- after entry, the current page stays usable, explainable, and recoverable instead of silently drifting or sticking on loading states

## Hard Constraints

- Use official OpenCode only.
- Do not fork `opencode`.
- Do not require an `opencode` plugin.
- Do not patch upstream source.
- Do not rely on private frontend internals as a compatibility foundation.
- Do not let the launcher become the sync engine.
- Do not let the relayer interfere with OpenCode Desktop on non-launcher machines.
- Do not treat syntax, sandbox, or partial HTTP checks as release evidence.

## Product Boundary

### Launcher boundary

The launcher is already considered stable and is not the redesign target for `0.1.2`.

It remains responsible for:

- detecting the current Tailscale host on the launcher machine
- keeping the official OpenCode CLI healthy on that machine
- exposing the correct host, port, and router entry data
- staying quiet and non-intrusive

It must not become:

- the primary sync authority
- a multi-machine scheduler
- a product shell around OpenCode

### Relayer boundary

The relayer is the redesign target.

It owns:

- public browser entry
- target discovery by Tailscale IP
- target classification
- launch-time inspection and state seeding
- cache and warm coordination on VPS
- session routing
- page-level freshness coordination after entry
- failure explanation and recovery paths
- release-grade observability and browser verification

It must not become:

- a replacement for OpenCode
- a fork-dependent sync engine
- a broad HTML rewrite shell
- a hidden controller over arbitrary remote desktops

## Target Model

`0.1.2` introduces two target types.

### 1. Launcher-managed target

This is the one machine that runs the launcher.

The relayer may depend on that machine to keep official `opencode web` alive and may request entry against it.

### 2. Attach-only target

This is any other machine reachable by Tailscale IP.

The relayer may:

- probe it
- inspect health
- read session metadata and messages
- route the browser into its OpenCode web UI if available

The relayer must not:

- auto-start the CLI there
- stop or restart any local process there
- interfere with that machine's OpenCode Desktop behavior

This split is a first-class product rule, not an implementation accident.

## What 0.0.12 Already Solved

`0.0.12` already proved the baseline relay value:

- same-origin browser entry through the VPS router
- disk-backed cache reuse
- watcher-driven refresh
- SSE progress and events
- offline-aware launch fallback
- automatic host and port injection from the launcher

`0.1.2` must preserve those strengths and build on them rather than replacing them.

## What 0.1.0 Wanted That Still Matters

The old `0.1.0` path got the implementation boundary wrong, but the user experience goal was still valid.

What is worth preserving:

- the current session page should not feel blind to changes made from another terminal
- active-session freshness matters more than background history work
- the user should need fewer manual refreshes and fewer manual session switches
- the system should treat foreground continuity as a product concern

What must be discarded:

- plugin-mode sync authority
- forked app delivery
- app-side native event bridge as a release dependency

## Core Capabilities of 0.1.2

### A. Target Registry

The relayer must keep a target registry rather than treating every request as a brand-new host:port guess.

Each target needs durable relayer state:

- target identity
- target type: launcher-managed or attach-only
- current health
- OpenCode version
- latest known session summary
- recent failure reasons
- recent availability window

### B. Compatibility Contract

The relayer must explicitly depend only on stable official surfaces:

- official CLI web startup behavior
- stable HTTP health/session/message surfaces
- official auth model when enabled
- router-side state and browser-side same-origin relay logic

The relayer must be resilient to OpenCode upgrades by anchoring on those surfaces and isolating anything more brittle behind small compatibility helpers.

### C. Admission and Launch Scheduling

The relayer must decide, per target:

- can I enter immediately?
- do I need to wait for launcher-managed availability?
- is this attach-only and therefore read/connect only?
- should I fail fast, retry, or degrade gracefully?

This replaces the current implicit, best-effort launch behavior with an explicit target admission model.

### D. VPS-Centered Warm and Cache Engine

The VPS must do real work, not just proxy bytes.

It should own:

- target-scoped cache
- session index reuse
- active-session-first warming
- old-history deprioritization
- backoff and failure budget tracking
- queue control under multi-target pressure

### E. Foreground Session Coordinator

After entry, the relayer remains responsible for safe current-page coordination.

It should know:

- whether the current page is stale
- whether a refresh is safe
- whether a defer or re-enter is safer
- whether the target is offline or recovering

This is not app-native realtime collaboration. It is safer near-realtime continuity for the current page.

### F. Recovery and Explainability

The relayer must turn failures into product states, not mysteries.

Expected states include:

- live
- syncing
- stale
- protected
- offline
- attach-only unavailable
- launcher-managed unavailable

The system must explain why the user is waiting, why the page refreshed, why it refused to refresh, or why a target cannot be entered.

## Non-Goals

- no upstream plugin path
- no OpenCode fork release path
- no desktop takeover
- no cross-machine remote control beyond launcher-managed start policy
- no promise of strong consistency
- no heavy UI shell around upstream OpenCode

## Success Criteria

`0.1.2` succeeds when all of the following are true:

- a launcher-managed target can be entered reliably through the relayer using official OpenCode only
- an attach-only target can be probed and entered if already available, without any remote process control
- the VPS relayer uses target-scoped state, warming, and caching rather than stateless request guessing
- the open session page remains safer and more explainable after entry than in `0.0.12`
- the final release is gated by a real browser path that exits `/__oc/launch` and lands on a real `/session/` route for both desktop and mobile
- no fork, plugin, or upstream patch is required

## Release Gates

`0.1.2` is not shippable until all four gates pass:

1. **Local CLI baseline**
   - official CLI only
   - expected health and session visibility
   - launcher-managed machine stays non-intrusive

2. **VPS relayer baseline**
   - target registry and relayer surfaces work as designed
   - `progress`, `events`, and `healthz` reflect current truth

3. **Real browser gate**
   - desktop passes
   - mobile passes
   - no login prompt
   - no stuck launch page

4. **Regression gate**
   - `0.0.12` strengths are preserved: launch reliability, cache fallback, same-origin entry, and launcher host/port injection

## Execution Intent

The implementation order for `0.1.2` should be:

1. restore the official CLI baseline cleanly
2. stabilize single-target relayer entry
3. introduce target registry and target-type boundaries
4. strengthen VPS warm/cache scheduling
5. add or refine current-page coordination only after the base path is stable

This order is mandatory because `0.1.2` should first become cleanly shippable, then become stronger.
