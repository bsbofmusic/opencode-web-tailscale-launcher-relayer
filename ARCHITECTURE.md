# OpenCode Tailnet Relayer v0.1.6 架构原则

> **核心定位**：Relayer 只拥有"连接与缓存的真相"，不拥有"工作区与会话的真相"。

---

## 一、六条不可谈判的 Invariant

### 1. Cache 永远不是 Authority
- disk hydrate 后必须标记 `stale=true` 或 `warm=false`
- 任何 live 请求优先覆盖 cache
- cache 只能加速，不能决定当前 workspace/session

### 2. Background 永远不覆盖用户当前选择
- watcher/warm/background job 只做 cache 补全
- **禁止写入** `client.view / client.activeSessionID / client.activeDirectory`
- watcher 是纯观察者，不是行为驱动器

### 3. 显式用户上下文永远高于 Latest
- 用户当前 session/workspace > any `latest` > any disk-hydrated cache
- `progressPayload` 的 `launchTarget` 计算时，如果 `client.view` 已设置，禁止用 `meta.sessions.latest` 覆盖

### 4. Synthetic Workspace 是 Display-Only
- `relay:*` 项目 ID 只出现在项目列表 UI
- **不应进入任何控制面逻辑**（`launchTarget`、`syncState`、`latestByRoot`）

### 5. 浏览器 Injected Runtime 只观测，不驱动导航
- `sessionSyncRuntime` 可以做 head 比较、状态上报、soft-refresh
- **禁止在用户已有有效视图时触发强制 re-enter**

### 6. Workspace 模型来自 Upstream，不来自 Relayer 合成
- `buildWorkspaceRoots / projectInventory / latestByRoot` 的结果只能作为 cache hint
- **不能作为 `meta.sessions.latest` 的来源**

---

## 二、Relayer 边界清单

### Relayer 应该拥有（绿区）
✅ 连接性真相：target health / admission / backoff / observability  
✅ 缓存：raw upstream response cache（`lists / messages / details / assets`）  
✅ 入口控制：same-origin launch gate / offline fallback  
✅ 类型判断：launcher-managed vs attach-only 的边界  

### Relayer 不应该拥有（红区）
❌ 产品真相：workspace/session/project 的当前状态  
❌ 用户导航：自动 re-enter / 跨 workspace 强制跳转  
❌ 上游模型重写：synthetic project 作为控制面真相  
❌ 浏览器状态机：auto soft-refresh 覆盖用户当前 session  

### 灰区（可以有，但只能是派生缓存）
⚠️ `inventory / workspaceSessions / projects / bootstrap / shellHtml`  
⚠️ `client.viewHead / client.remoteHead / syncState / staleReason`  
→ 这些可以留，但**只能是派生缓存，不能当 authority**

---

## 三、v0.1.6 修复目标

### 问题 1：点击 E:\CODE 跳回 D:\CODE
**根因**：`progressPayload` 在 cold launch 时用 `meta.sessions.latest`（D:\CODE）覆盖用户已选 E:\CODE

**修复**：Patch A — `control.js` launchTarget 优先保护用户当前视图

### 问题 2：Watcher 触发循环覆盖
**根因**：watcher tick 写入 `client.syncState / client.viewHead`，触发 SSE `sync-stale` → 浏览器 `apply()` → 再次 re-enter

**修复**：Patch B — `watcher.js` 恢复纯观察者身份，删除所有 `client.*` 写入

### 问题 3：latestByRoot fallback 混入跨 workspace session
**根因**：`latestByRoot` fallback 到 discovery list 时会混入所有 workspace 的 session

**修复**：Patch C — `warm.js` latestByRoot 收紧，fallback 时不跨 workspace

---

## 四、从 v0.0.12 借鉴的设计原则

| 原则 | v0.0.12 做法 | v0.1.6 继承 |
|------|------------|-----------|
| 单一真相源 | upstream /session → meta.sessions.latest | ✅ 保持，但加用户视图优先 |
| Watcher 纯观察 | 只刷新 cache，不碰 client | ✅ 恢复 |
| 不注入浏览器运行时控制 | 无 auto re-enter | ⚠️ 保留 runtime，但禁止强制 re-enter |
| 无 synthetic workspace 合成 | 无 projectInventory | ⚠️ 保留但降级为 display-only |
| disk cache 是 degraded fallback | hydrate 后立刻被 live 覆盖 | ✅ 恢复 stale 标记 |

---

## 五、v0.1.6 保留的性能优化

✅ 异步 disk cache 写入（debounce）  
✅ fast-path warm（不等 fetchAllWorkspaceRoots）  
✅ asset/bootstrap 预热（但不作为控制面依赖）  
✅ watcher 跳过 unchanged session list  

---

## 六、验收标准

### 功能验收
- [ ] 点击 E:\CODE 后，浏览器停留在 E:\CODE，不跳回 D:\CODE
- [ ] 二次打开同一 workspace，不跳回其他 workspace
- [ ] session/agent/sync 不丢失
- [ ] 多 workspace 切换稳定

### 性能验收
- [ ] cold launch 时间 ≤ v0.1.5
- [ ] 二次打开时间 ≤ v0.1.5
- [ ] watcher CPU 消耗 ≤ v0.1.5

### 稳定性验收
- [ ] Playwright 5/5 通过
- [ ] 连续切换 10 次 workspace 无跳转
- [ ] 重启 VPS 后恢复正常

---

## 七、禁止事项（防止回归）

🚫 **禁止 watcher 写入 `client.*` 任何字段**  
🚫 **禁止 `progressPayload` 在 `client.view` 已设置时用 `latest` 覆盖**  
🚫 **禁止 `latestByRoot` fallback 时跨 workspace 混入 session**  
🚫 **禁止 `sessionSyncRuntime` 在用户有效视图时强制 re-enter**  
🚫 **禁止 synthetic project 进入 `launchTarget` 计算**  

---

**版本**：v0.1.6  
**日期**：2026-04-14  
**状态**：架构定义完成，待实施
