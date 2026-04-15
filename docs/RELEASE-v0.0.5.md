# OpenCode Tailnet Launcher v0.0.5

## Summary

- Kept the warm-cache launch flow from `v0.0.4` and hardened it for weak mobile networks.
- Added upstream keep-alive plus per-target heavy-request throttling so the VPS stops opening too many large remote reads at once.
- Tuned nginx to compress large JSON responses and keep long-lived proxy connections stable.

## What Changed

### Router transport stability

The VPS router now:

- reuses upstream TCP connections with a keep-alive agent
- limits concurrent heavy requests per target
- queues expensive `/session*` reads instead of flooding the remote Windows host
- reduces mobile warmup to the latest session only, while desktop warms a slightly broader snapshot

### Mobile-friendly warm behavior

- desktop warmup snapshot count dropped from 4 to 2
- mobile warmup snapshot count dropped to 1
- the router still serves warmed session list, session detail, and message responses from cache when available

### nginx tuning

The nginx config now adds:

- gzip compression for JSON, JS, CSS, and manifest payloads
- longer proxy read/send timeouts for slow links
- socket keepalive and disabled request buffering for streaming-friendly proxy behavior

## Validation

Validated before deployment with:

- local router syntax checks
- three sequential self-contained sandbox passes after the transport changes
- live nginx syntax validation on the VPS
- live `curl` checks confirming:
  - `__oc/progress` still works
  - warmed session responses still return `X-OC-Cache: hit`
  - gzip compression is applied to warmed message payloads
  - launch still returns quickly for a mobile user agent

## Notes

- This release improves transport stability and payload delivery, but it does not fully remove upstream OpenCode workload costs on very large sessions.
- Existing site-level CSP warnings remain outside the router stability work.
