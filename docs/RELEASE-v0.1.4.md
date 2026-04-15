# OpenCode Tailnet Relayer v0.1.4

## Summary

- Restored multi-workspace visibility so the relay no longer collapses to the hottest workspace only.
- Changed the Tailnet status chip from a permanent overlay to a non-obstructive default-hidden behavior.
- Preserved the existing 0.1.3 baseline: page opens, no white screen, session list works, `加载更多` works, and history loading works.

## What Changed

### Multi-workspace roots

`v0.1.4` stops treating “recent session directories” as the whole workspace truth.

The relayer now:

- keeps a wider session discovery window
- merges that discovery with project/worktree-aware browser seed state
- preserves multiple roots in the browser's project view instead of overwriting them with the latest directory only

Result: roots like `D:\CODE` and `E:\CODE` can both be surfaced in the live UI.

### Tailnet chip behavior

The Tailnet chip is now hidden by default in normal `live` state.

This removes the long-standing problem where it obstructed search or other primary OpenCode UI controls.

## Verification

### Manual browser verification

Path used:

1. Open `https://opencode.cosymart.top/`
2. Enter `100.121.130.36`
3. Enter `3000`
4. Click `Open Remote OpenCode`

Verified results:

- The page loads and does not white-screen
- Session list is visible
- `加载更多` increases visible session count
- `加载更早的消息` is visible
- The Tailnet chip is not visible in normal live state

### Multi-workspace verification

- After opening the relay page, the browser project state contains both `D:\CODE` and `E:\CODE`
- Clicking the second `CODE` workspace changes the visible project/session panel from `D:\CODE` to `E:\CODE`

## Notes

- This release still uses official OpenCode only.
- Launcher remains narrow; relayer remains the product core.
- 0.1.4 focuses on workspace correctness and UX cleanliness, not deeper cold-start performance redesign.
