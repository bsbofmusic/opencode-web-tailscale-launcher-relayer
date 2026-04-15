# OpenCode Tailnet Relayer v0.1.3 WIP

## 目标

继续把当前 relayer 版本往原生 OpenCode web 体验对齐，但坚持：

- 官方 OpenCode only
- 不 fork
- 不 plugin
- 不 patch upstream
- launcher 继续窄职责
- relayer 继续做产品核心

## 已对齐的体验

### 1. 入口与首屏

- 从 `https://opencode.cosymart.top/` 手动输入 target 后，desktop / mobile 都能进入最终 session 页面
- 页面不白屏
- `#root` 已挂载
- 页面标题为 `OpenCode`

### 2. session 列表与加载更多

- roots session list 不再错误回退到 warmed 55 条缓存
- 点击 `加载更多` 后，可见 session 数量从 `6` 增长到 `11`

### 3. 历史消息

- relay 页面已经重新出现 `加载更早的消息`
- 当前 session 的 `message` 请求链已恢复

### 4. target 边界

- `launcher-managed` 与 `attach-only` 两种 target truth surfaces 都已验证

## 当前仍落后于原生的核心差距

### 首屏时延仍然偏高

当前量化结果：

- 原生直连：
  - `message` 首次请求约 `370ms`
  - `project/current` 约 `485ms`
  - `roots session list` 约 `486ms`

- relay 冷启动：
  - `message` 首次请求约 `11485ms`
  - `project/current` 约 `11272ms`
  - `roots session list` 约 `6202ms`

- relay 热启动：
  - `message` 首次请求约 `6630ms`
  - `project/current` 约 `6210ms`
  - `roots session list` 约 `4826ms`

最新优化后：

- session HTML shell TTFB：`2553ms -> 1032ms`
- assets 二次命中：
  - JS `ttfb=170ms`, `x-oc-cache=hit`, `gzip`, `immutable`
  - CSS `ttfb=338ms`, `x-oc-cache=hit`, `gzip`, `immutable`
- 当前 relay 首轮数据链（最新量化）：
  - `message` 约 `5941ms`
  - `project/current` 约 `5452ms`
  - `roots session list` 约 `5033ms`

这些数据说明功能正确性已经恢复，但性能仍未追平原生。当前唯一主抓手仍然是首轮数据链时延。

## 当前已验证有效的性能方向

### 热态 current message / current project 缓存

对当前会话 `message(limit=80)` 和当前目录 `project/current` 的热态缓存命中策略，在本地 WIP 中已验证有效：

- 第一次打开：
  - `rootsAt ≈ 9636ms`
  - `projAt ≈ 10297ms`
  - `msgAt ≈ 10558ms`

- 第二次打开：
  - `rootsAt ≈ 6288ms`
  - `projAt ≈ 7770ms`
  - `msgAt ≈ 8405ms`

这说明这条方向对热态确实有正收益，后续可继续沿这条线优化，但在完全验证之前不直接污染 live。

### live 提升后的最新量化

在将 `project/current` 缓存命中策略提升到 live 之后，最新真人入口时间线已改善为：

- `rootsAt ≈ 4025ms`
- `messageAt ≈ 4473ms`
- `projectAt ≈ 5975ms`
- `加载更早的消息` 出现时间 `olderAt ≈ 5584ms`

这说明首轮数据链已经从 5~11 秒级继续压到约 4~6 秒级，功能和用户感知都在继续逼近原生。

## 当前策略

- **线上 live 环境** 保持在最后一次已知可用的 `0.1.2` 运行时主链，不再继续承接未验证的性能试验。
- **0.1.3 优化** 作为离线性能分支推进，只在量化收益明确后再合入 live。

## 当前 live 验证状态

当前线上已恢复到已知可用状态，并再次通过真人路径检查：

- landing page 可用
- session 页面可打开
- session 列表可见
- `加载更多` 可用
- `加载更早的消息` 可见

这意味着：当前 live 以功能可用和正确性优先，性能继续在 0.1.3 线上之外推进。

## 已做但仍未完全收口的优化

- session HTML 代理改为短连接
- `/assets/*` 代理改为短连接
- VPS 内存态 asset cache 已加入
- VPS 磁盘态 asset persistence 已加入

## 下一步抓手

唯一主抓手仍是：

> 让 relay 首屏资源链与首轮数据链进一步逼近原生，而不是继续补功能表象。

下一步优先级：

1. 继续减少首次 `/assets/*` 的 TTFB
2. 缩短 `project/current` 和 `message` 首次请求延迟
3. 再次做 desktop / mobile 真人路径验证

## 架构升级结论

经过本轮验证，轻量 patch 路线的收益已经接近上限。

下一阶段不再继续 patch 单个请求时序，而是转入：

- `docs/superpowers/specs/2026-04-11-tailnet-relayer-0.1.3-cold-start-design.md`

该设计把问题重新定义为：

> 如何让 relay 页面在冷启动时就拥有更接近原生的最小前端初始化状态，而不是在页面打开后靠浏览器和后端慢慢补齐。
