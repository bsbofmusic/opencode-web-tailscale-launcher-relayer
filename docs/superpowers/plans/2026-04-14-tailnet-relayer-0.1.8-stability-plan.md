# Tailnet Relayer v0.1.8 Stability Plan

> **Status:** Draft  
> **Owner:** OpenCode relayer maintenance  
> **Review lane:** stability-first / no broad refactor / relayer-only  
> **Decision date:** 2026-04-14

## Release Goal

在**不打坏当前网页、不修改 upstream OpenCode、本次版本不做 broad refactor**的前提下，完成 `v0.1.8` 的稳定性收敛：

1. 先把“对话内容经常回到很久以前”这个主问题诊断清楚并做最小修复。
2. 只在**稳定性不下降**时再做内容载入速度优化。
3. 实时同步只做保守路线图，不在 `v0.1.8` 里引入高风险机制。

---

## 1. Release Intent And Non-Goals

### 1.1 Primary goal order

1. **正确性第一：** 修复 message body / conversation content 错乱，避免旧对话内容压过新内容。
2. **速度第二：** 只有在不破坏稳定性的前提下再优化内容载入速度。
3. **实时第三：** 仅给出未来优化路线图，不追求本版本“更实时”。

### 1.2 Non-goals

`v0.1.8` 明确不做以下事情：

- 不修改 upstream OpenCode 本体
- 不做 router 全局状态模型重写
- 不做 cache/storage 架构重构
- 不做 watcher 全量轮询所有 session
- 不做 WebSocket / DOM patch / 乐观式实时同步
- 不把无关清理工作捆绑进本版本

---

## 2. Proven Facts

本节只记录**已证实事实**，不夹带方案。

### 2.1 用户真实症状

- 网页版经常需要手动刷新，才能恢复正确的对话内容。
- 大约三分之二的记录会短暂或较长时间显示为很久以前的旧对话内容。
- 当前问题重心已从“页面跳错”转为“页面路由可能正确，但 message body 内容错误”。

### 2.2 现有系统已知行为

- `router/routes/cache.js` 会对 `GET /session/:id/message` 直接返回 `state.messages` 中的缓存结果。
- 只有 `messageBypass()` 判定通过时，message 请求才会绕过缓存。
- `messageBypass()` 当前主要依赖两类权威：
  - `client.activeSessionID + activeDirectory`
  - `state.meta.sessions.latest`
- `watcher.js` 只持续追踪活跃 client 相关的 session，不是全量刷新所有 session。
- `disk-cache.js` 会持久化并恢复 `state.messages`。
- 近期对 `pages.js` 的修复已明显改善：
  - session A/B 切换时的错误跳转
  - archive 后被 runtime 拉回的问题

### 2.3 已知运行约束

- 当前系统首要目标是“网页正确和稳定”，不是“尽可能实时”。
- 任何会增加错误刷新、错误跳转、错误回拉风险的改动都不应优先进入 `v0.1.8`。

---

## 3. Open Hypotheses

本节记录**高置信到中置信假设**，每条都必须有后续验证动作。

### H1. message body 缓存失效机制本身不可靠

- **Confidence:** High
- **Why:** 只要当前 view 没被正确识别，message 请求就会继续命中旧 `state.messages`。
- **Validation:** 给 `/session/:id/message` 命中链路增加结构化日志，确认错误时是否出现 `cache hit=true + bypass=false`。
- **Disqualifier:** 如果错误场景下大多数请求根本不是 cache hit，这条假设就要降级。

### H2. active / view / latest 三套权威源仍然在 message 层打架

- **Confidence:** High
- **Why:** 路由问题已缓解，但 body 仍经常错误，说明权威判定仍可能落后或错位。
- **Validation:** 同时打出请求 URL session、client.active、client.view、meta.latest 四套值。
- **Disqualifier:** 如果错误时四者高度一致，则主问题不在权威源冲突。

### H3. 冷 session 未被 watcher 刷新，切入时直接吃到旧缓存

- **Confidence:** High
- **Why:** watcher 只追热点 session，冷 session 切入很可能直接看到 오래된 body。
- **Validation:** 打点 tracked session 集合，检查用户刚切入的 session 是否长期不在追踪集里。
- **Disqualifier:** 如果错误 session 在出错时已稳定被 watcher 刷新，则这条假设要降级。

### H4. disk-cache hydrate / warm 把旧 body 恢复回来并继续对外服务

- **Confidence:** High
- **Why:** `state.messages` 被持久化；如果 hydrate 后没有强 revalidate，旧 body 就会复活。
- **Validation:** 给 message entry 加 `source=memory|disk|watcher|warm` 和 `ageMs` 标记。
- **Disqualifier:** 如果错误 entry 基本不来自磁盘恢复，则这条只作为次要因素。

### H5. pages.js 仍有残余影响，但不再是主根因

- **Confidence:** Medium
- **Why:** 当前主要症状更像服务端给错 body，而不是前端跳错页面。
- **Validation:** 记录错误发生时是否有异常 route hook / soft-refresh / re-enter。
- **Disqualifier:** 如果几乎所有错乱都伴随异常前端刷新，则需重新抬高这条假设。

---

## 4. Constraints And Guardrails

### 4.1 Stability-first rules

- 先诊断，再修复；没有证据前不改 message 缓存主行为。
- 一次只改一个层面：诊断、message 缓存、速度优化、实时路线图不能混成一锅。
- 所有行为改动都必须可回滚、可验证、可隔离。

### 4.2 Allowed change surface

`v0.1.8` 允许的改动面：

- `router/routes/cache.js`
- `router/routes/proxy.js`
- `router/routes/control.js`
- `router/state.js`
- `router/sync/watcher.js`
- `router/sync/disk-cache.js`
- `router/warm.js`
- 必要的验证脚本与文档

### 4.3 Forbidden patterns

- broad refactor
- 同时修改 3 个以上状态权威面且没有分阶段 gate
- 以“看起来更实时”为目标的高风险改动
- 未做基线测量就做性能优化
- 在没有观测证据前继续堆 `pages.js` 补丁

---

## 5. Workstream Overview

| ID | Priority | Problem | Outcome | Change surface | Risk | Gate to start | Gate to ship |
|----|----------|---------|---------|----------------|------|---------------|--------------|
| W0 | P0 | 对话内容错乱根因未被量化 | 拿到 stale chain 证据 | logging / diagnostics only | Low | 立即开始 | 至少 1 轮真实复现场景证据齐全 |
| W1 | P1 | 当前会话 message body 经常吃旧缓存 | 当前会话内容正确性显著提升 | cache/state/control | Medium | W0 证据确认 | 错乱显著下降且网页稳定 |
| W2 | P2 | 内容载入速度仍有空间 | 提速但不影响正确性 | warm/meta/transport | Medium-Low | W1 稳定后 | 首屏更快且无新错乱 |
| W3 | P3 | 实时同步不够理想 | 给出后续低风险路线图 | design only in v0.1.8 | Low | 与 W0/W1 并行规划 | 仅文档，不直接 ship 行为 |

---

## 6. Detailed Plan Per Workstream

## W0 / P0 — 只做诊断，不改行为

### Problem

当前没有足够证据区分：

- 是 cache invalidation 失效
- 还是 active/view/latest 错位
- 还是 watcher 未追踪
- 还是 disk hydrate 复活旧 body

### Smallest safe change

只增加观测字段，不改变现有对外行为。

### Tasks

- [ ] 在 `router/routes/cache.js` 为 `/session/:id/message` 增加结构化命中日志：
  - `directory`
  - `sessionID`
  - `limit`
  - `cacheHit`
  - `cacheAgeMs`
  - `bypass`
  - `bypassReason`
  - `entrySource`
  - `client.activeSessionID`
  - `client.view.sessionID`
  - `meta.sessions.latest.id`

- [ ] 在 `router/sync/watcher.js` 增加 tracked session 观测：
  - 当前 tracked 数量
  - 当前 tracked session key 列表摘要
  - 当前 client view 是否被 watcher 纳入追踪

- [ ] 在 `router/sync/disk-cache.js` / `router/warm.js` 增加来源标记：
  - `source=memory|disk|watcher|warm`
  - `cachedAt`
  - `restoredAt`

- [ ] 设计一个固定复现场景：
  1. 两个活跃 session A/B 轮流切换
  2. 一个冷 session C 长时间未查看后重新打开
  3. relayer 重启后重新进入旧 session

### Acceptance criteria

- 能明确回答“错误内容是从哪里来的”。
- 至少有一份日志链能完整描述 stale body 胜出的路径。

### Stop-loss

- 如果 48 小时内仍无法从日志中分辨 stale chain，则冻结功能修复，先补观测而不是继续试 patch。

---

## W1 / P1 — 最小行为修复（仅在 W0 高置信证据成立时执行）

### Problem

message body 作为高敏感对象，不适合继续维持当前这种“默认缓存 + 少量 bypass”的强缓存策略。

### Smallest safe change strategy

只调整 **message body** 的缓存语义，不碰页面跳转语义，不碰 upstream，不碰 broad state rewrite。

### Proposed actions

- [ ] **P1.1 当前会话强 bypass / 极短 TTL**
  - 当前正在查看的 session message 请求默认 bypass，或强制极短 TTL
  - 目标：优先保证“当前看到的内容对”

- [ ] **P1.2 非当前会话短 TTL**
  - 非当前 session 的 message body 仍可缓存，但 TTL 明显缩短
  - 避免冷 session 长时间维持旧 body

- [ ] **P1.3 disk-hydrate message 默认 stale-on-read**
  - 若 W0 证据确认问题大量来自磁盘恢复，则 message body 恢复后第一次读取必须 revalidate
  - meta/session index 可继续保守保留，不与 message body 绑定处理

- [ ] **P1.4 弱化 `meta.sessions.latest` 对 message body 的权威性**
  - `latest` 可以继续用于入口、warm 和元数据，不再作为 body 是否可直接返回的强依据

### Acceptance criteria

- 在固定复现场景中，连续切换活跃 session 20 次，旧对话 body 错乱次数应降到 **≤ 1 次**。
- 在固定复现场景中，冷 session 重新打开 10 次，旧 body 误命中次数应降到 **≤ 1 次**。
- relayer 重启后重复进入旧 session 10 次，来自磁盘恢复的旧 body 若被服务，必须在首个读取周期内完成 revalidate；不允许持续错误展示超过 **1 次页面刷新周期**。
- 页面稳定性不下降：browser smoke test 必须继续 **5/5 通过**，且不得回归 workspace jump-back、archive revive、刷新风暴。

### Stop-loss

- 如果修复必须同时大改 watcher + cache + control 三个层面，立即拆分，不允许 bundling ship。

---

## W2 / P2 — 稳定性优先的速度优化

### Problem

用户还希望内容载入速度提升，但前提是不能再把正确性压坏。

### Allowed optimization types

- [ ] 只优化元数据与 warm path：
  - health/meta/session list
  - latest session 的最小首屏准备
  - 背景预热调度顺序

- [ ] 只在证据充分时考虑传输层优化：
  - 条件请求 / 304
  - 更轻量的首屏依赖集

### Excluded optimization types

- 不通过继续增强 message body 强缓存来换速度
- 不通过扩大 watcher 全量扫描来换速度
- 不通过更激进的前端自动刷新来换“看起来更快”

### Acceptance criteria

- 首屏/切入速度有明确提升或确认无收益后停止。
- 正确性指标不能下降。

### Stop-loss

- 只要提速方案改变了 message 正确性语义，立即终止，不进入 `v0.1.8`。

---

## W3 / P3 — 实时同步路线图（本版本只做规划）

### Problem

用户希望未来实时同步更好，但不能打坏网页。

### Planning direction

- [ ] 未来优先考虑“版本号 / 修订号驱动的重新校验”
  - 事件只通知“可能变了”
  - 客户端再按保守规则重新拉取

- [ ] 不直接把 SSE 演化成消息 body patch 推送
- [ ] 不在未统一单一权威源之前做复杂实时

### Acceptance criteria

- 形成一份后续设计约束清单：
  - 什么情况下可以继续做实时优化
  - 什么情况下必须止损

### Stop-loss

- 如果实时设计需要同时重写缓存语义和页面 runtime，则推迟到更大版本，不进入 `v0.1.8`。

---

## 7. Acceptance Criteria For v0.1.8

### Correctness

- [ ] 当前会话的 message body 不再频繁回到很久以前的内容
- [ ] 大量手动刷新才能恢复内容的现象显著下降
- [ ] relayer 重启后旧对话 body 不会明显复活

### Stability

- [ ] 不引入新的 workspace jump-back
- [ ] 不引入新的 archive revive
- [ ] 不引入新的刷新风暴或页面错误跳转

### Performance

- [ ] 如果做了 P2 提速，必须有基线对比并证明正确性未下降
- [ ] 如果提速收益不明显，则不强上优化

### Web safety

- [ ] 不修改 upstream OpenCode
- [ ] 所有行为改动可单独回滚

---

## 8. Stop-Loss / Abort Rules

- 如果根因在约定观测窗口内仍不明确，停止继续 patch，优先增强观测。
- 如果修复需要 broad refactor，冻结 `v0.1.8` 范围，拆出后续版本。
- 如果性能优化引入 correctness 风险，立即放弃性能优化。
- 如果实时同步方案会明显增加网页被打坏的概率，直接延期，不进入 `v0.1.8`。

---

## 9. Do Not Do Yet

- 不继续在 `pages.js` 上堆 message 内容纠偏逻辑
- 不扩 watcher 为全量 session 轮询器
- 不把 `messageBypass()` 发展成巨型特殊条件树
- 不做 WebSocket / DOM patch / optimistic merge
- 不延长 message body TTL
- 不在没有 P0 证据前做 broad refactor

---

## 10. Validation And Release Gates

### Execution ownership

- **实施 owner：** relayer 维护者
- **验证 owner：** 浏览器回归验证 + 线上 smoke test
- **冻结/回滚判定：** 只要出现 archive revive、workspace jump-back、页面无法进入 session、或 browser smoke test < 5/5，立即冻结本轮行为改动

### Gate 1 — P0 diagnostics complete

- stale chain 已被日志清楚描述
- 能说清 old body 来自 memory / disk / watcher / warm 哪一层

### Gate 2 — P1 fix isolated and verified

- 行为改动只聚焦 message body 缓存语义
- browser regression、archive regression、workspace regression 都重新过一遍

### Gate 3 — P2 optional only if safe

- 只有在 W1 稳定后再尝试速度优化
- 没有明确收益就不 ship

### Gate 4 — P3 stays design-only unless risk is bounded

- 实时同步在 `v0.1.8` 中只输出设计与边界，不默认实现

---

## 11. Final Decision Recommendation

`v0.1.8` 的正确执行顺序：

1. **先做 P0 诊断**，拿到 stale chain 证据
2. **再做 P1 最小修复**，优先收敛 message body 的缓存语义
3. **最后才考虑 P2 提速**，而且只做低风险优化
4. **实时同步仅保留路线图**，除非风险已经被严格隔离和验证

一句话总结：

> `v0.1.8` 不是继续“修页面表现”，而是要把 message body 从强缓存对象降级为保守缓存对象；先稳住内容正确性，再谈速度和实时性。
