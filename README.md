# OpenCode Tailnet Relayer

> 把局域网里的 OpenCode 网页转发到公网浏览器，零魔改、体验和原生一样。

---

## 一句话说明

这是 **Relayer 主仓**。

它负责把浏览器请求转发到你的局域网 OpenCode，让你通过公网浏览器使用 OpenCode Web。

**Launcher 已迁移到独立仓库：**
- `https://github.com/bsbofmusic/opencode-tailnet-launcher-windows`
- Windows 发布物：`OpenCodeTailnetLauncher.exe`

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

Relayer 只负责一件事：接收浏览器请求 → 转发给 Tailscale → 返回结果给浏览器。中间不存数据、不改请求。

---

## 快速开始

### 1. Launcher（Windows，独立仓库）

请前往独立仓库下载：

- `https://github.com/bsbofmusic/opencode-tailnet-launcher-windows`

Windows 发布物：

- `OpenCodeTailnetLauncher.exe`
- `OpenCodeTailnetLauncher-v0.0.1-single.zip`

### 2. Relayer（VPS / Linux，本仓库）

这是源码仓，不是 npm 包仓。

最小启动方式：

```bash
# 1. 复制整个仓库到 VPS，例如 /opt/opencode-router
# 2. 使用 systemd 模板：deploy/systemd/opencode-router.service.example
# 3. 使用 nginx 模板：deploy/nginx/opencode-router.conf.example
# 4. 正式入口是：router/vps-opencode-router.js
node router/vps-opencode-router.js
```

完整部署步骤见：

- `docs/DEPLOY_VPS.md`

### Launcher ↔ Relayer 最小契约

要让 Windows launcher 和 relayer 联动可用，至少要满足：

1. relayer 必须部署在公开 HTTPS 域名后面
2. launcher 的 `router_url` 必须指向该域名，例如：
   - `https://your-domain.example.com/?autogo=1`
3. launcher 本机运行的 `opencode web` 端口要与 launcher 配置一致（默认 `3000`）
4. 如需把某些 Tailscale 主机视为 launcher-managed 目标，应在 relayer 侧配置：
   - `OPENCODE_ROUTER_LAUNCHER_HOSTS=100.x.x.x,100.y.y.y`

没有这 4 条，别人即使把 relayer 跑起来，也不一定能和 launcher 无歧义联动成功。

---

## 升级记录

### v0.1.8（2026-04-15）— message body 稳定性止血版

**这次修了什么：**
- 切换 session 时高频切到古早对话记录
- 冷 session 打开时容易看到旧 body
- relayer 重启后，旧 message body 可能从磁盘恢复并复活

**这次怎么修：**

本次没有再继续修 `pages.js`，而是把主战场收敛到 **server-side message body 缓存语义**：

1. `limit=80` 的 `/session/:id/message` 不再从 `state.messages` 直接返回，一律走 upstream 真值
2. 其余 message cache 也不允许 stale-hit 直接返回；过期后改为 miss + refresh
3. `message body` 不再落盘，也不再从 disk hydrate 恢复，避免古早对话复活
4. 保留 P0 诊断信息（headers + healthz debug），继续为后续收敛根因提供证据

**验证结果：**
- VPS 已部署
- `/__oc/healthz` 正常
- `/__oc/meta` 正常
- 浏览器 smoke test 5/5 通过
- 保留可回滚到 `v0.1.7` 的 git/tag 和 VPS 备份路径

### v0.1.9（2026-04-15）— 新客户端工作区恢复 + 部署文档补齐

**这次修了什么：**
- 新电脑或无痕模式打开时，看不到 `D:\CODE` / `E:\CODE` 等工作区
- 老浏览器还能看到工作区，但 fresh browser 完全没有 workspace roots

**这次怎么修：**

1. 在 `router/pages.js` 的 launch seed 中恢复最小 OpenCode 兼容 bootstrap
2. 只补 `server/projects`、`globalSync.project`、`defaultServerUrl` 三个浏览器端兼容 key
3. 只做 workspace/project 可见性恢复，不重新接管 active session / 导航状态
4. 同时补齐 relayer 仓的部署/联动说明，降低外部用户部署歧义

**验证结果：**
- 线上 fresh browser 已验证拿到：
  - `opencode.global.dat:server`
  - `opencode.global.dat:globalSync.project`
  - `opencode.settings.dat:defaultServerUrl`
- 新浏览器上下文已恢复显示：
  - `D:\CODE`
  - `D:\CODE\opencode-tailscale`
  - `E:\CODE`
- `/__oc/healthz` 正常
- `/project` 正常

### v0.1.7（2026-04-14）— session 同步稳定性修复

**这次修了什么：**
- 两个活跃 session 来回切换时，第二个 session 偶尔会短暂显示旧消息
- 最近一次修复后，session archive 会被 relayer 误拉回，出现“归档后复活”

**这次怎么修：**

只修改了 `router/pages.js` 的浏览器注入同步脚本，不碰 OpenCode upstream，也不改 relayer 的主缓存策略。

1. 不再在脚本启动时固定 session/directory，而是每次都从当前 URL 动态读取
2. `apply()` 和 `checkHead()` 都增加 route drift guard，旧请求结果不会覆盖新页面
3. session 切换时先 `apply()` 再 `checkHead()`，减少错误刷新
4. history 路由 hook 收紧为 **仅 session → session 切换** 时触发同步
5. session → 非 session（例如 archive 后离开详情页）不再触发 `pulse(true)`，避免把已归档 session 拉回

**验证结果：**
- VPS 已部署
- `/__oc/healthz` 正常
- `/__oc/meta` 正常
- 浏览器 smoke test 5/5 通过

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

### Launcher release line
- Launcher 已迁移到独立仓库维护
- 当前独立 launcher 基线版本：`v0.0.1`
- 下载地址：`https://github.com/bsbofmusic/opencode-tailnet-launcher-windows/releases/tag/v0.0.1`

---

## 注意事项

- **不修改 OpenCode 源码**，只做网络转发
- Relayer 无状态，重启不丢用户 session（session 保存在 OpenCode 自身）
- Launcher 和 Relayer 独立运行，可以只跑其中一个
- Launcher 源码与 exe 发布已迁移到独立仓库

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
├── vps-opencode-router.js     ← Relayer 入口
└── opencode-router.service    ← VPS systemd 配置
```
