# Tailnet Sync 0.1.1 Design

**Status:** Draft for review

**Goal:** Build `0.1.1` as the active-session-sync release on top of the `0.1.0` persistent relay shell, while keeping the relay-only boundary intact.

**One-line definition:** `0.1.1` turns the router from a launch-time cache warmer into a continuous active-session coordinator that can detect stale session heads, decide whether refresh is safe, and bring the current page back into sync without patching `opencode` itself.

## Baseline

`0.1.1` assumes `0.1.0` already provides these foundations:

- The public entry remains the VPS router plus the Windows launcher.
- The router already owns launch, cache warmup, offline fallback, per-client state, and transparent proxy handoff.
- The router can already detect target health changes, session-list changes, and cached message changes through watcher-driven refresh.
- The router can already remember the client's active session after a successful session HTML open.
- The relay-only rule remains absolute: no upstream `opencode` source modifications, no plugin dependency, no forked app delivery.

What is still missing at the end of `0.1.0` is the post-launch freshness loop. The router can see that data changed, but the current session page still does not have a formal, safe, router-driven path to react to that change.

## Product Definition

`0.1.1` should feel like this:

- A user opens a session through the router and keeps working inside the normal `opencode web` UI.
- If the same session advances on another terminal, the current page becomes aware that it is stale.
- If refresh is safe, the page re-syncs automatically with minimal disruption.
- If refresh is not safe, the page shows a lightweight protected or stale state and waits for a safer moment.
- If the target goes offline, the user can still understand the state of the page and fall back to cached data instead of seeing silent drift.

This is not strong realtime collaboration. It is safe near-realtime consistency for the current session page, implemented entirely in the relay layer.

## Hard Constraints

- Do not modify `opencode` source code.
- Do not add a required `opencode` plugin.
- Do not rely on private frontend implementation details that change every release.
- Prefer the smallest correct router-side change over larger proxy rewriting.
- Preserve the existing `0.0.12` to `0.1.0` strengths: launch reliability, same-origin entry, offline fallback, cache reuse, and multi-client isolation.
- Keep the launcher quiet. It remains a host-and-port binder, not a sync engine.

## Non-goals

- No attempt to create app-native realtime diff merging.
- No promise of millisecond-level or protocol-level strong consistency.
- No redesign of the `opencode web` UI.
- No heavy shell around the upstream page.
- No broad HTML rewriting across the entire upstream app.

## Success Criteria

`0.1.1` is successful when all of the following are true:

- The router can determine whether the current client view of its active session is stale.
- The relay can choose between `soft-refresh`, `defer`, and `re-enter` based on current risk.
- The current session page can move between `live`, `syncing`, `stale`, `protected`, and `offline` states without upstream code changes.
- Active-session sync gets higher priority than latest-session prefetch and old-history background work.
- Operators can tell why the router refreshed, deferred, or refused to refresh by using router events, headers, and `healthz`.

## Architecture

`0.1.1` adds six design units on top of the `0.1.0` router shell.

### 1. Session Head Authority

The router becomes the authority for session-head freshness. Each target keeps a lightweight summary of the latest known head for the active session and latest session.

The head summary stays intentionally small:

- `sessionID`
- `directory`
- `messageCount`
- `tailID`
- `updatedAt`

`messageCount` and `tailID` are the primary freshness inputs. `updatedAt` is for observability, not for correctness.

### 2. Stale Classifier

The router translates watcher observations into a small set of stale reasons instead of exposing raw background events only.

The stale reasons for `0.1.1` are:

- `head-advanced`
- `session-switched`
- `target-offline`
- `resume-protected`
- `pty-protected`

This classifier marks state but does not decide the action.

### 3. Refresh Coordinator

The router owns the decision about what to do when the current page becomes stale.

Allowed actions:

- `noop`
- `soft-refresh`
- `defer`
- `re-enter`

The default action is `soft-refresh`. `defer` is used when the router believes refresh would be unsafe or overly disruptive. `re-enter` is a controlled fallback used only when the page context is no longer trustworthy.

### 4. Relay Runtime

The router injects one lightweight runtime into session HTML pages. This runtime is part of the router, not part of upstream `opencode`.

The runtime subscribes to router events, tracks a tiny client-side state machine, and applies the refresh action selected by the router.

The runtime state vocabulary is fixed for `0.1.1`:

- `live`
- `syncing`
- `stale`
- `protected`
- `offline`

### 5. Active-First Watcher

Watcher work is no longer a mostly global scan. `0.1.1` reorders attention toward the active session first.

Priority order:

- current client's active session
- target latest session
- other background history

### 6. Operator Surface

The router must expose enough detail to explain what happened without opening the upstream app.

Required surfaces:

- `/__oc/events`
- `/__oc/progress`
- `/__oc/healthz`
- `X-OC-Relay-*` headers

## File Blueprint

`0.1.1` stays in the formal delivery repo.

### Router files to modify

- `router/state.js`
- `router/sync/watcher.js`
- `router/routes/control.js`
- `router/routes/proxy.js`
- `router/routes/static.js`
- `router/dispatch.js`
- `router/pages.js`

### Router files to add

- `router/runtime/session-sync.js`

### Delivery and documentation files to modify

- `launcher/OpenCodeTailnetLauncher.cs`
- `README.md`
- `docs/DEPLOY_VPS.md`
- `docs/RELEASE-v0.1.1.md`

The launcher changes in `0.1.1` are intentionally small. It only needs a version bump and release packaging alignment.

## Design Units

## Part A: Session Head Authority

**Purpose**

Track a target-level and client-level view of session freshness so the relay can tell whether the current page is behind the upstream head.

**How to build it**

Extend `router/state.js` with explicit head fields for both target and client state.

Target state additions:

- `latestHead`
- `activeHeads` keyed by client id
- `syncVersion`
- `lastSyncAt`

Client state additions:

- `view`
- `viewHead`
- `remoteHead`
- `syncState`
- `staleReason`
- `lastAction`
- `lastActionAt`

The router should update `view` and `viewHead` only after a successful session HTML open or a successful relay-driven refresh. This prevents failed navigation attempts from poisoning the active-session truth.

The head summary should be derived from the same message payloads the router already fetches or caches. `0.1.1` must not add an extra heavy upstream endpoint just to compute freshness.

**How to verify it**

- Add deterministic local checks that derive the same head summary from cached message bodies and fresh upstream message bodies.
- Confirm a failed session HTML navigation does not replace the previous `viewHead`.
- Confirm a successful session HTML navigation updates `activeSessionID`, `activeDirectory`, and `viewHead` together.

**What gets delivered**

- Head-tracking state in the router
- Stable rules for when a head becomes authoritative
- No user-visible UI change yet

## Part B: Stale Classifier

**Purpose**

Translate raw watcher changes into a small, stable stale model that downstream router logic and the browser runtime can both understand.

**How to build it**

Extend `router/sync/watcher.js` so it compares the previous and next head summary for the active session and latest session.

Watcher output should become semantic, not just observational. In addition to existing `message-appended` and `session-list-updated`, the router should emit new sync events:

- `sync-head-changed`
- `sync-stale`
- `sync-cleared`
- `sync-action`

Required payload:

- `client`
- `sessionID`
- `directory`
- `reason`
- `action`
- `state`
- `version`
- `timestamp`

The classifier must only mark a client stale if the changed head belongs to the client's current active session or clearly invalidates it through session switch. Background session changes alone must not flip the current page into stale mode.

**How to verify it**

- Replay a change in an unrelated session and confirm the active client stays `live`.
- Replay a head advance in the active session and confirm the client becomes `stale` with reason `head-advanced`.
- Simulate target offline transition and confirm the client becomes `offline` without a forced refresh action.

**What gets delivered**

- Stable sync event contract on the router side
- One stale-reason vocabulary used across watcher, control routes, runtime, and diagnostics

## Part C: Refresh Coordinator

**Purpose**

Choose the least disruptive action that can restore freshness for the current page.

**How to build it**

Place the coordinator in `router/routes/control.js` and state helpers in `router/state.js`.

Decision rules for `0.1.1`:

- Use `soft-refresh` when the client is stale, the target is online, and the router is not in `resume-safe` or `pty-protected` mode.
- Use `defer` when the client is stale but the router is protecting the page because of idle recovery or PTY activity.
- Use `re-enter` only when one of these conditions is true: the current page no longer has a valid session context, two consecutive `soft-refresh` attempts fail to restore head parity, or the router detects a session identity mismatch after refresh.
- Use `noop` when the target is offline or when the router already knows the current browser state matches the remote head.

The coordinator should publish its decision through `/__oc/progress` and `/__oc/events`. It should not depend on the browser to invent its own policy.

**How to verify it**

- Enter resume-safe and confirm stale detection leads to `defer` instead of `soft-refresh`.
- Mark PTY active and confirm auto-refresh is suppressed.
- Force a repeated refresh mismatch and confirm the action escalates to `re-enter`.
- Confirm offline mode produces `noop` plus `offline` state.

**What gets delivered**

- Router-owned sync action policy
- A safe fallback ladder from `soft-refresh` to `re-enter`
- Fewer invisible refresh decisions

## Part D: Relay Runtime

**Purpose**

Give the current session page a router-controlled way to react to sync state changes after the initial launch.

**How to build it**

Add `router/runtime/session-sync.js` and serve it through `router/routes/static.js` and `router/dispatch.js` at the fixed router-owned path `/__oc/runtime/session-sync.js`.

Inject this runtime only into proxied session HTML pages from `router/routes/proxy.js`. Do not inject it into the landing page or generic API responses.

Runtime responsibilities:

- open `EventSource` to `/__oc/events`
- maintain the five-state model: `live`, `syncing`, `stale`, `protected`, `offline`
- render a very small fixed-position sync chip or banner owned by the router
- call `/__oc/progress` when a router event indicates stale state or action change
- execute the router-selected action

Action handling rules:

- `soft-refresh` means reload the current session route in place, preserving the current pathname, query, and client id, without going back through launch seeding.
- `defer` should leave the page alone and only update the runtime state to `protected` or `stale`.
- `re-enter` should redirect through `/__oc/launch` or the exact session path selected by the router, not through a blind browser refresh.

The runtime must stay small and dumb. It reports its local status and executes router decisions, but does not perform its own freshness inference.

**How to verify it**

- Open a session page and confirm the runtime asset is injected exactly once.
- Confirm unrelated pages do not receive the runtime.
- Trigger `sync-stale` and confirm the runtime state moves from `live` to `syncing` to `live` when action is `soft-refresh`.
- Trigger `resume-protected` and confirm the runtime shows `protected` and does not reload the page.
- Trigger `target-offline` and confirm the runtime shows `offline` without creating a reload loop.

**What gets delivered**

- One router-owned runtime script
- One small user-visible sync indicator
- A post-launch freshness loop without upstream code changes

## Part E: Active-First Watcher

**Purpose**

Spend router work where it matters most: the session currently on screen.

**How to build it**

Adjust `router/sync/watcher.js`, `router/state.js`, and cache access logic so active-session message-head checks happen before background history refresh.

Priority order must be enforced consistently across:

- watcher polling
- heavy request queueing
- background refresh scheduling
- cache bypass decisions for recent messages

The router should refresh the head of the active session first, then the latest session if different, then old history. This keeps the current page aligned without letting background prefetch compete on equal footing.

**How to verify it**

- Generate active-session traffic and old-history traffic together; confirm active-session checks finish first.
- Confirm recent-message bypass still applies to the active session head.
- Confirm unrelated history prefetch does not flip the current page into stale state.

**What gets delivered**

- Stronger freshness on the current page
- Lower risk that background work steals router capacity from the active session

## Part F: Operator Surface

**Purpose**

Make router behavior explainable during live debugging and release validation.

**How to build it**

Extend `router/routes/control.js` and response-header helpers so the router exposes sync-specific fields.

Required `progress` fields:

- `syncState`
- `staleReason`
- `lastAction`
- `lastActionAt`
- `viewHead`
- `remoteHead`
- `protected`

Required `healthz` fields:

- active client count
- stale client count
- protected client count
- per-target active session summary
- last sync version
- last sync error

Required response headers on relevant session and control responses:

- `X-OC-Relay-Sync-State`
- `X-OC-Relay-Stale-Reason`
- `X-OC-Relay-Action`

These headers complement, not replace, existing `X-OC-Relay-Priority`, `X-OC-Relay-Mode`, and `X-OC-Relay-Reason`.

**How to verify it**

- Confirm session HTML responses expose sync headers after a stale transition.
- Confirm `healthz` shows protected and stale counts after simulated idle and PTY scenarios.
- Confirm router events and `progress` payloads agree on `syncState` and `lastAction`.

**What gets delivered**

- A debuggable sync surface
- Release-ready evidence for why router behavior changed

## Runtime State Machine

The browser runtime follows this state machine:

- `live` -> `stale` when the router emits a stale event for the active session.
- `stale` -> `syncing` when the router action is `soft-refresh`.
- `syncing` -> `live` when the router confirms the browser head matches the remote head.
- `stale` -> `protected` when the router action is `defer` because of resume-safe or PTY protection.
- `protected` -> `syncing` when protection clears and the router later selects `soft-refresh`.
- `live` or `stale` -> `offline` when the target goes offline.
- `offline` -> `syncing` -> `live` when the target returns and the router restores freshness.

## End-to-End Flows

### Flow 1: Normal multi-terminal advance

- Client A opens a session through the router.
- Client B advances the same session.
- The watcher detects an active-session head advance.
- The stale classifier marks Client A stale with `head-advanced`.
- The refresh coordinator selects `soft-refresh`.
- The relay runtime syncs the page and returns to `live`.

### Flow 2: Idle recovery

- Client A leaves a session idle long enough to enter resume-safe.
- The session advances elsewhere.
- The router marks the page stale but chooses `defer`.
- The runtime shows `protected` instead of refreshing immediately.
- Once the protection window clears, the router selects `soft-refresh` on the next stale evaluation.

### Flow 3: PTY protection

- The target has active terminal traffic.
- A session-head advance is detected.
- The router marks the page stale with `pty-protected` and chooses `defer`.
- The runtime shows `protected` and waits.

### Flow 4: Target offline

- The target drops offline while the page is open.
- The router emits `target-offline` and sets sync state to `offline`.
- The runtime shows `offline` and avoids forced reload.
- When the target returns, the router can restore `syncing` then `live`.

### Flow 5: Session switch

- The user manually opens a different session.
- The router updates active session identity only after the HTML route succeeds.
- Stale logic now follows the new session, not the old one.

## Verification Matrix

`0.1.1` requires four layers of verification.

### 1. Router unit and helper verification

- Head-summary derivation from cached and fresh message bodies
- Stale classifier decisions for related versus unrelated sessions
- Refresh coordinator decisions across normal, resume-safe, PTY, mismatch, and offline paths

### 2. Router sandbox verification

Add or extend sandbox coverage so the router can simulate:

- active-session head advance
- unrelated session change
- idle recovery window
- PTY activity window
- target offline then online recovery
- repeated refresh mismatch that escalates to `re-enter`

### 3. Browser behavior verification

Validate with the router-served session HTML that:

- runtime injection only happens on session HTML
- sync chip or banner updates correctly
- soft-refresh does not create a loop
- protected mode does not unexpectedly navigate away
- offline mode stays readable

### 4. Live relay verification

Validate against a real Tailscale target that:

- two terminals on the same session reach visible consistency within a few seconds
- idle and PTY protections suppress unsafe refresh
- `healthz`, `progress`, SSE, and response headers report the same sync story

`0.1.1` must not be declared complete until all four layers are checked.

## Delivery Package

The release deliverables for `0.1.1` are:

- router code changes implementing active-session sync
- one router-owned runtime asset
- updated router documentation in `README.md`
- updated VPS deployment notes in `docs/DEPLOY_VPS.md`
- release notes in `docs/RELEASE-v0.1.1.md`
- launcher version bump to keep distribution metadata consistent

The release does not include a modified `opencode` binary.

## Rollout

Rollout order:

1. land router state and watcher changes
2. land coordinator and diagnostics changes
3. land runtime asset and HTML injection
4. run sandbox verification
5. run live relay verification
6. update docs and release notes
7. ship `0.1.1`

This order preserves the stable relay baseline while reducing the blast radius of the runtime addition.

## Risks and Guardrails

### Risk: runtime behavior becomes too smart

Guardrail: keep freshness inference in the router and keep the runtime execution-only.

### Risk: HTML injection becomes brittle

Guardrail: inject one small router asset into session HTML only, instead of broad DOM rewriting.

### Risk: background work steals capacity from active-session sync

Guardrail: enforce active-first ordering in watcher, heavy queueing, and bypass rules.

### Risk: auto-refresh surprises the user

Guardrail: use explicit `protected` and `offline` states, plus `defer` during idle recovery and PTY activity.

### Risk: the release drifts toward fork behavior

Guardrail: the delivery package remains limited to router, launcher, and docs in the formal repo.

## Release Acceptance Checklist

- Active session head tracking exists and stays correct after successful and failed navigation.
- Stale reasons are explicit and shared across router internals and browser runtime.
- The router chooses `soft-refresh`, `defer`, `re-enter`, or `noop` deterministically.
- Session HTML pages receive the router runtime and non-session pages do not.
- Active-session sync work is prioritized over latest-session and old-history work.
- `progress`, `events`, `healthz`, and response headers expose the sync story clearly.
- Docs and release notes describe the relay-only architecture correctly.
- No `opencode` source patch is introduced.

## What Comes Next

After this spec is approved, the next artifact should be the `0.1.1` implementation plan. That plan should break this design into small execution tasks with exact files, tests, commands, and release steps.
