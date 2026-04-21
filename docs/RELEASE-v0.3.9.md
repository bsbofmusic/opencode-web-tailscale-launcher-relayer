# RELEASE v0.3.9

## 定位

`v0.3.9` 是在 `v0.3.8` 冻结基线之上完成的正式交付版。

本次收口重点不是再加新功能，而是：

- 完成 Source Boundary 收口
- 保持原生操控面 parity
- 保持 safe 模式免刷新同步

## 本次完成内容

### 1. Source Boundary 收口

- 默认 inventory 只保留 launcher-managed backend 当前暴露的 truth
- 不再把旧的 browser-side desktop-style state merge 回当前 origin inventory
- 不再把 synthetic `relay:*` 混入默认 inventory / `globalSync.project`
- 仍保留 backend 正常暴露出来的有效 session/workspace

### 2. 原生操控面保持可用

- 默认主路径可进入 Web
- send 可用
- session jump 可用
- workspace switch 可用
- archive 可用
- unarchive 当前 UI 未暴露，记 `N/A`

### 3. 微加速同步 safe 模式成立

- `off / safe / experimental` 三档明确
- safe 模式下无需手动刷新网页即可看到变化
- runtime key 已 target-aware
- same-route soft refresh 受 guard 限制
- `80/200` message 视图一致

## 最终边界

- CLI-first
- launcher-managed backend truth only
- 不把 Desktop UI/runtime/default-server/recent-projects 当 truth
- synthetic `relay:*` 仅 display-only，不进入默认真相层
- warm/cache/watcher/stale projection 只能 assist，不能当 authority

## 最低验收摘要

- `verify-launch-gate.js`：通过
- `verify-fresh-browser-gate.js`：通过
- `verify-source-boundary.js`：通过
- `verify-safe-auto-refresh.js`：通过
- `_verify-workspace-switch.js`：通过
- isolated live send probe：通过
- isolated live archive probe：通过
- refresh continuity：通过
- `80/200` consistency：通过

## 恢复说明

### Git 恢复

```bash
git fetch --tags
git checkout v0.3.9
```

### 从 bundle 恢复

```bash
git clone opencode-tailscale-v0.3.9.bundle opencode-tailscale-restore
cd opencode-tailscale-restore
git checkout v0.3.9
```

## 版本关系

- `v0.3.8`：冻结封板基线
- `v0.3.9`：正式交付版
