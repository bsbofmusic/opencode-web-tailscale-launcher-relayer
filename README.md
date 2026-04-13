# OpenCode Tailnet Launcher & Relayer

> 把局域网里的 OpenCode 网页转发到公网浏览器，零魔改、体验和原生一样。

---

## 一句话说明

这个工具让你在任何地方用浏览器打开 OpenCode 网页版，体验和在本机打开一模一样——包括工作区切换、session 保持、编排模式。

**两件事：**
- **Launcher**（Windows 小工具）：常驻系统托盘，保持 OpenCode 在线
- **Relayer**（VPS 服务）：把浏览器请求转发到你的局域网 OpenCode，不改 OpenCode 源码

---

## 工作原理

```
你的浏览器（公网 HTTPS）
    ↓
VPS 中转服务（nginx :443）
    ↓
Tailscale 隧道（加密打洞）
    ↓
局域网 OpenCode（:3000）
```

Launcher 只负责一件事：让 Tailscale 隧道保持活跃，不掉线。

Relayer 只负责一件事：接收浏览器请求 → 转发给 Tailscale → 返回结果给浏览器。中间不存数据、不改请求。

---

## 快速开始

### 1. Launcher（Windows）

下载 `opencode-tailnet-launcher.html`，双击打开，配置 Tailscale auth key，保存运行。

### 2. Relayer（VPS / Linux）

```bash
# 安装依赖
npm install

# 配置（参考 opencode-router.service）
# TAILSCALE_UPSTREAM=100.x.x.x:3000
# PORT=3000

# 运行
node vps-opencode-router.js
```

---

## 升级记录

### v0.1.6（2026-04-13）— Phase 2-5 收口

**Phase 2b — disk-cache 重启恢复旧状态**
relayer 重启后从磁盘加载缓存时，没有检查缓存是否过期。缓存超过 5 分钟就标记为"过期但可用"，确保不阻塞 UI 显示，同时通知下游数据可能不新鲜需要刷新。

**Phase 3 — watcher 每次 tick 全量扫描**
watcher 每次运行都无差别调用 `fetchAllWorkspaceRoots`，即使 session 列表没有任何变化。改为比较 session discovery list 是否变化，只有变化时才做全量扫描，大幅降低 watcher CPU/网络消耗。

**Phase 4 — checkHead 缺 workspaceMismatch 保护**
浏览器后台 head 检查触发 soft-refresh 时没有检查工作区是否匹配，可能导致跨工作区刷新。补全与 `apply()` 一致的 `workspaceMismatch` 保护。

**Phase 5 — PATCH relay:* directory 缺失时仍发上游**
当 directory 参数缺失时，`PATCH /project/relay:*` 会越过本地短路逻辑直接发到 OpenCode 上游并返回 500。改为任何带 `relay:*` 项目 ID 的 PATCH 都本地处理，不再依赖 directory 参数。

---

### v0.1.5（2026-04-13）— Phase 1 收口 85分版

**修复了什么问题：**
- 第二次打开页面时工作区跳回旧地址
- session 丢失（编排模式没了）
- 页面加载要等 1-2 分钟
- 状态栏长期暗灯

**修复方式（Phase 1 — 状态权威统一）：**

| 位置 | 问题 | 修复 |
|------|------|------|
| `state.js` syncClientView | 后台同步每分钟把用户选定的工作区覆盖成最新 | 删除回退逻辑，已选中的 session 不被动覆盖 |
| `control.js` progressPayload | launchTarget 用的是"最新 session"而不是用户当前 session | 优先用用户当前 session 作为导航目标 |
| `watcher.js` | 后台扫描重建 latest，导致刚切过去又被抢回来 | watcher 只读不写，不碰 client view |
| `warm.js` | 冷启动要等所有工作区扫描完才能进入页面 | 快速路径：先进入，后台补全扫描 |
| `pages.js` seed() | relayer 写了 OpenCode 自有的 localStorage 键 | 停止写入，只保留 relay 自有的键 |

### v0.1.3 — 多工作区支持
- 支持额外的 workspace 根目录（如 E:\CODE）
- Launcher 自动探测 workspace 路径

### v0.1.2 — Relayer 核心
- VPS 部署 relayer + Tailscale 代理
- Session 保持、Warm 缓存、后台 watcher

### v0.1.1 — Launcher 初始版
- Windows 系统托盘小工具
- Tailscale auth key 管理
- 网络变化自动重连

---

## 注意事项

- **不修改 OpenCode 源码**，只做网络转发
- Relayer 无状态，重启不丢用户 session（session 保存在 OpenCode 自身）
- Launcher 和 Relayer 独立运行，可以只跑其中一个

---

## 项目结构

```
opencode-tailscale/
├── router/                    ← Relayer 核心代码（Node.js）
│   ├── routes/                HTTP 路由（proxy、cache、control）
│   ├── sync/                  后台 watcher + 磁盘缓存
│   ├── pages.js               浏览器端注入脚本
│   ├── state.js               状态同步逻辑
│   └── warm.js                冷启动加速
├── launcher/                  ← Launcher 源码（C#，预发布）
├── vps-opencode-router.js     ← Relayer 入口
└── opencode-router.service    ← VPS systemd 配置
```
