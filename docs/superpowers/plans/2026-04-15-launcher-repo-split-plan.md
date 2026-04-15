# Launcher / Relayer Repo Split Plan

> **Status:** Draft  
> **Owner:** OpenCode maintenance  
> **Decision date:** 2026-04-15  
> **Goal:** main 仓库只保留 relayer；launcher 迁出到独立仓库，launcher 的发布物为 Windows `exe/zip`。

---

## 1. 目标边界

### main 仓库（保留）

只保留 **Relayer**：

- `router/**`
- `deploy/**`
- `vps-opencode-router.js`
- relayer 的验证/部署脚本
- relayer 的 README / docs / release notes

### launcher 新仓库（新增）

只保留 **Launcher**：

- `launcher/OpenCodeTailnetLauncher.cs`
- `launcher/build-oc-launcher.ps1`
- `launcher/generate-oc-launcher-icon.ps1`
- `launcher/OpenCodeTailnetLauncher.ico`
- `launcher/oc-launcher.ini.example`

发布物：

- `OpenCodeTailnetLauncher.exe`
- `OpenCodeTailnetLauncher-<version>-single.zip`

---

## 2. 发布规则（立即生效）

### Relayer

- 版本线：`v0.1.x`
- GitHub Release 标题格式：`OpenCode Tailnet Relayer vX.Y.Z`
- 不包含 launcher 版本语义

### Launcher

- 独立版本线
- GitHub Release 标题格式：`OpenCode Tailnet Launcher vX.Y.Z`
- Release asset 必须包含 `exe` 或 `zip`

---

## 3. 迁移顺序

## Phase 0 — 冻结边界（现在）

目标：不再混发 release。

动作：

- [ ] main 仓库 release 全部按 relayer 口径发布
- [ ] launcher 以后只在新仓库发 exe/zip
- [ ] main README 增加“launcher 将迁移到独立仓”的说明（迁移时再改）

止损：

- 如果当前 relayer 稳定性还在高频修复，暂不进入 Phase 2 之后的动作

---

## Phase 1 — 先在当前仓收敛 launcher 真相

目标：拆仓前先把 launcher 收拾干净。

### 1.1 唯一源码入口

只认 `launcher/` 为 launcher 真正源码入口。

动作：

- [ ] 以 `launcher/OpenCodeTailnetLauncher.cs` 为唯一源码真相
- [ ] 以 `launcher/build-oc-launcher.ps1` 为唯一构建真相
- [ ] 根目录重复文件标记为待淘汰：
  - `oc-launcher.cs`
  - 根目录 `build-oc-launcher.ps1`
  - 根目录其它 launcher 重复文件

### 1.2 唯一版本真相

目标：launcher 的显示版本、打包版本、release 版本统一。

动作：

- [ ] 对齐 `AppVersion` 与打包脚本里的 release 名称
- [ ] 确认 `exe` / `zip` / release 标题使用同一版本号

### 1.3 去路径耦合

目标：launcher 不再依赖当前 mono-repo 路径布局。

动作：

- [ ] 清理 `oc-launcher.ini` 中对当前仓路径的硬编码假设
- [ ] 明确 launcher 的运行依赖是配置项，不是仓库结构

### 1.4 契约文档

目标：拆仓后 launcher / relayer 仍有明确接口。

新增文档：

- `docs/launcher-relayer-contract.md`

必须写清楚：

- launcher 负责什么
- relayer 负责什么
- `router_url` / `cli_path` / `port` / `cors_origin` / `poll_seconds` / `auto_start`
- 兼容版本矩阵

---

## Phase 2 — 创建 launcher 新仓库

建议仓库名：

- `opencode-tailnet-launcher`

迁入文件：

- `launcher/OpenCodeTailnetLauncher.cs`
- `launcher/build-oc-launcher.ps1`
- `launcher/generate-oc-launcher-icon.ps1`
- `launcher/OpenCodeTailnetLauncher.ico`
- `launcher/oc-launcher.ini.example`

新仓新增：

- launcher 专属 `README.md`
- launcher release 文档
- launcher 构建 / 发布说明

止损：

- 如果 Phase 1 未完成，不允许创建新仓作为正式发布入口

---

## Phase 3 — 兼容期

目标：用户入口不断裂。

动作：

- [ ] main README 改成 relayer-first
- [ ] main README 增加 launcher 新仓库链接
- [ ] main 仓只保留 launcher 下载入口和兼容说明，不再保留 launcher 源码真相
- [ ] 一段过渡期内，主仓文档继续指向 launcher 下载地址

兼容矩阵必须明确：

| Launcher 版本 | Relayer 版本 | 支持状态 |
|---------------|--------------|----------|
| vX.Y.Z | v0.1.8+ | Supported |

### 兼容期退出标准

满足以下条件后，才允许进入 Phase 4：

- [ ] launcher 新仓连续完成至少 1 次正式 exe/zip 发布
- [ ] main README 中的新仓链接、下载链接、兼容矩阵连续 14 天无断链
- [ ] 用户侧已能稳定从新仓获取 launcher，不再依赖主仓源码目录
- [ ] relayer 主仓在兼容期内未因 launcher 迁移引入新的发布混淆或安装问题

---

## Phase 4 — 清理主仓冗余 launcher 内容

目标：主仓只保留 relayer。

动作：

- [ ] 移除根目录重复 launcher 源码/构建脚本
- [ ] 移除主仓中不再作为真相的 launcher 产物
- [ ] 清理旧 launcher-only 文档，保留历史索引或迁移说明

止损：

- 如果 launcher 新仓下载链、发布链、README 链接有任何断裂，不进入 Phase 4

---

## 4. 文件归属表

### 留在 main（relayer）

- `router/**`
- `deploy/**`
- `vps-opencode-router.js`
- relayer 部署与验证脚本
- relayer docs

### 迁到 launcher 新仓

- `launcher/**`

### 待淘汰 / 兼容期后清理

- `oc-launcher.cs`
- 根目录 `build-oc-launcher.ps1`
- 根目录 launcher 重复文件
- 主仓内 launcher 旧 release 口径文案

---

## 5. 验收标准

### Phase 1 完成标准

- `launcher/` 成为唯一源码入口
- launcher 版本号只有一个真相
- launcher 不再依赖当前主仓路径布局
- 契约文档完成

### Phase 2 完成标准

- launcher 新仓可独立构建 `exe/zip`
- launcher 可独立发 GitHub Release

### Phase 3 完成标准

- main README 已经只把自己定义为 relayer 主仓
- launcher 下载入口存在且不歧义
- 用户可以明确知道 exe 去哪里下

### Phase 4 完成标准

- main 只保留 relayer 源码与 relayer release
- launcher 只在 launcher 新仓维护和发布

---

## 6. 现在就做 / 暂时不做

### 现在就做

- Phase 0
- Phase 1

### 暂时不做

- 不立刻迁仓
- 不立刻删主仓旧 launcher 文件
- 不把 relayer 当前稳定性工作和拆仓动作混在同一波上线

---

## 7. 一句话执行结论

先在当前仓内把 launcher 收敛成“唯一源码入口 + 唯一版本真相 + 稳定契约”，再把它迁到独立 launcher 仓库；main 仓库只保留 relayer。
