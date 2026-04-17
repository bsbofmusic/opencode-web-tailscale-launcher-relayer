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

### v0.2.2（2026-04-17）— fresh/incognito 兼容层补全版

**这次修了什么：**
- 在稳定 fallback 版里，停止 relayer 写 upstream 导航 authority 是正确的
- 但同时把 fresh/incognito 启动所需的最小兼容 bootstrap 也删过头了
- 结果是：
  - 正常浏览器还能靠旧 localStorage 勉强工作
  - fresh / incognito 会出现工作区 roots 丢失
  - `verify-fresh-browser-gate.js` 失败

**这次怎么修：**

1. 恢复最小 compat bootstrap，但**不恢复导航 authority**：
   - `opencode.global.dat:server`
   - `opencode.global.dat:globalSync.project`
   - `opencode.settings.dat:defaultServerUrl`
   - `opencode.router.dat:compat-target`
2. 保持禁止写这些旧机制：
   - `layout.page`
   - `server.lastProject`
   - latest-session / referer / warm.latest authority
3. 将 compat bootstrap 同时补到：
   - launch 页 seed
   - session HTML 注入 runtime
4. 修正 workspace authority 缓存面：
   - `/path` 只按当前目录返回
   - `/project/current`、roots、detail 与当前 workspace 对齐
5. 验证链收口：
   - fresh/incognito gate
   - stable gates
   - E workspace authority probe
   - E workspace create session + prompt append probe

**验证结果：**
- `verify-fresh-browser-gate.js`：通过
- `verify-stable-gates.js`：通过
- `relay-benchmark.js`：通过
- fresh/incognito 打开后可看到：
  - `server`
  - `globalProject`
  - `defaultServer`
  - `snapshot`
- `E:\CODE` 的 `/path`、`/project/current`、roots、detail 一致
- `E:\CODE` 新建 session 后可正常 `prompt_async` 并看到消息追加

### v0.2.1（2026-04-17）— 稳定 fallback 版

**这次目标：**
- 不再继续追求“更聪明”的 relayer，而是先交付一个 **慢一点但稳定** 的版本
- 优先保证：
  1. workspace 下的 session 能正确加载
  2. send / continue 能正确落到当前 workspace/session
  3. 对话能自动更新，不依赖整页刷新

**这次怎么修：**

1. 收口 authority：
   - 不再让 `latest-session`、`warm.latestDirectory`、`meta.latest` 参与主工作区判定
   - 工作区/session authority 只认显式 `directory/sessionID` 和当前 active authority
2. 停止 relayer 写 upstream 导航持久化：
   - 不再写：
     - `opencode.global.dat:server`
     - `opencode.global.dat:globalSync.project`
     - `opencode.settings.dat:defaultServerUrl`
3. prompt/send 改成 fail-closed：
   - authority 缺失时直接报错
   - 不再偷偷回 latest / peer / warm
4. `/path`、`/project/current`、`/agent`、detail fallback 收口到当前 workspace authority
5. browser/runtime 继续保持保守同步：
   - 不再做 message80 周期直拉
   - 发送后依赖 progress + direct reconcile/polling fallback
6. health 与 ready 更诚实：
   - 继续暴露 `schedulerMode / backgroundWarmPaused / ptyActive`

**验证结果：**
- `router-sandbox-check.js`：通过
- `verify-stress-gate.js`：通过
- `verify-stable-gates.js`：通过
- live benchmark：通过
- live workspace authority 验证：
  - `D:\CODE` / `E:\CODE` 的 `/path` 与 `/project/current` 一致
  - `E:\CODE` 新建 session 后可正常 `prompt_async` 并看到消息追加

### v0.1.15（2026-04-17）— 后台自恢复收紧版

**这次修了什么：**
- 长稳态压测里，后台虽然能恢复，但 `clients` 清理和后台过期任务回收还不够积极
- `healthz` 的 `targetStatus` 在恢复后仍可能显示旧状态，和真实当前态不一致

**这次怎么修：**

1. 在 `state.js` 的 self-heal 周期中，增加：
   - 更积极的 stale client 裁剪
   - 后台过期任务回收
2. 在 `control.js` 的 `healthz` 输出里：
   - 如果 `meta.ready` 且没有 `failureReason/lastError`，直接展示 `targetStatus=ready`

**验证结果：**
- 多轮 browser smoke：通过
- 多轮 fresh browser / incognito：通过
- 多轮 workspace switch：通过
- 长稳态综合压测中：
  - `failureReason` 持续为空
  - `lastError` 持续为空
  - `backgroundQueued` 最终回到 0
  - `clients` 压测后回落
  - `targetStatus` 与真实恢复态保持一致

### v0.1.14（2026-04-17）— 根路径 last-target 恢复

**这次修了什么：**
- 直接打开根路径 `https://.../` 时，只看到空壳 router 输入页
- 用户误以为“没有 session、没有编排器、没有工作区”，其实是 landing 页面没有恢复上次 target

**这次怎么修：**

1. `router/context.js`：landing 根路径允许从 `oc_target` cookie 恢复 target
2. `router/pages.js`：landing 页面在成功 `inspect/openLatest` 后保存 `last-target`
3. 下次打开 plain root 时，如果没有 query，但本地已有 `last-target`，会自动恢复 target 并进入原本的检查/打开流程

**验证结果：**
- plain root 在已有 target 上下文时可恢复进入 app
- browser smoke：通过
- fresh browser / incognito：通过
- 不破坏现有稳定门禁

### v0.1.13（2026-04-16）— 后台调度链抗压版

**这次修了什么：**
- 压力测试下，relayer 后台会积压并最终退化到 `Warm timed out after 30000ms`
- `clients` 与 `backgroundQueued` 在高压下不能及时回落
- 即使前台功能还正常，后台也可能在用户离开电脑后继续恶化

**这次怎么修：**

1. 后台调度链只动服务端，不碰浏览器热路径：
   - `router/index.js`
   - `router/state.js`
   - `router/heavy.js`
   - `router/warm.js`
   - `router/sync/watcher.js`
   - `router/routes/control.js`
2. `backgroundQueue` 增加：
   - 硬上限
   - TTL 过期丢弃
   - overload 时拒绝低价值后台任务
3. watcher 增加：
   - stale client 裁剪
   - tracked session 预算
   - roots refresh TTL
4. 新增 backend self-heal / watchdog：
   - `schedulerMode = normal / overload / recovering`
   - overload 时暂停低价值后台工作
   - watchdog 到时主动 drain 后台积压
5. 恢复成功后自动清理旧错误状态：
   - `failureReason`
   - `lastError`
   - `lastReason`

**压测结果：**
- 多轮 browser smoke：通过
- 多轮 fresh browser / incognito：通过
- 多轮 workspace switch：通过
- 长稳态综合压测中：
  - `failureReason` 维持为空
  - `lastError` 维持为空
  - `backgroundQueued` 最终回到 0
  - `clients` 从峰值回落
  - `schedulerMode` 能从 `overload` 回到 `normal/recovering`

### v0.1.12（2026-04-16）— 后台恢复态清理版

**这次修了什么：**
- 后台调度链已经能扛压，但 `healthz` 在恢复后还残留旧的 `failureReason / lastError / lastReason`
- 这会让运维误以为系统仍然坏着，即使前台功能和后台队列都已经恢复

**这次怎么修：**

1. 在 `router/state.js` 增加统一 `clearRecoveryState()` helper
2. 只在 `warm.js` 和 `watcher.js` 的**完整恢复成功点**调用它
3. 清掉：
   - `failureReason`
   - `offline`
   - `offlineReason`
   - `failureCount`
   - `backoffUntil`
   - `lastError`
   - `lastReason`
4. 不改浏览器热路径，不改 message body 语义，不改 upstream

**验证结果：**
- browser smoke：多轮通过
- fresh browser / incognito：多轮通过
- workspace switch：多轮通过
- 2 分钟稳态综合压测中：
  - `failureReason` 维持为空
  - `lastError` 维持为空
  - `backgroundQueued` 最终回到 0
  - `clients` 从峰值回落

### v0.1.11（2026-04-16）— 后台调度链稳定性修复

**这次修了什么：**
- 压力测试会把 relayer 后台打爆
- `healthz` 长时间退化成 `Warm timed out after 30000ms`
- `clients`、`backgroundQueued` 只涨不回落，导致用户离开电脑后也可能出问题

**这次怎么修：**

1. 后台调度链只动服务端，不碰浏览器热路径：
   - `router/index.js`
   - `router/state.js`
   - `router/heavy.js`
   - `router/warm.js`
   - `router/sync/watcher.js`
   - `router/routes/control.js`
2. `backgroundQueue` 增加：
   - 硬上限
   - TTL 过期丢弃
   - overload 时拒绝低价值后台任务
3. watcher 增加：
   - stale client 裁剪
   - tracked session 预算上限
   - roots refresh TTL
4. 新增 schedulerMode：
   - `normal`
   - `overload`
   - `recovering`
5. `healthz` 现在能直接看出：
   - 是否 overload
   - 是否正在 recovering
   - dropped / pruned 统计

**压测结果：**
- 多轮 browser smoke：通过
- 多轮 fresh browser / incognito：通过
- 多轮 workspace switch：通过
- 2 分钟稳态综合压测中：
  - `failureReason` 不再出现 warm timeout
  - `backgroundQueued` 最终回落到 0
  - `clients` 从峰值回落到 1
  - `schedulerMode` 能从 `overload` 回到 `recovering`

### v0.1.10（2026-04-16）— 稳定版重建

**这次修了什么：**
- 把失控的 `0.1.10` 尝试收回，回到已验证稳定的 `v0.1.9` 运行时内核
- 只在低爆炸面补最小 server-side 收口：
  - `/__oc/healthz` debug 默认收口
  - `/__oc/progress` query override 默认关闭且可观测
  - `/project` 坏 JSON 只做局部隔离，不再放大全局故障
- 补齐稳定版发布资产：
  - `v0.1.9` runtime manifest
  - rollback runbook
  - rollout runbook
  - stable gate scripts

**这次明确没有做：**
- 不继续扩写 `pages.js`
- 不继续扩写 `proxy.js / cache.js / disk-cache.js`
- 不把 message body 带回强缓存权威路线

**验证结果：**
- browser smoke：5/5 通过
- fresh browser / incognito gate：通过
- workspace switch：通过
- archive 打开后不复活，archived 标记仍保留
- `prompt_async + message?limit=80` 的 noReply 探针可单调追加用户消息
- rollback drill：已完成，从准确 `v0.1.9` 回滚再切回候选，门禁仍通过

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
