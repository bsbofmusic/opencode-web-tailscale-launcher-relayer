# Tailnet Relayer 0.1.4 Design

## 目标

在保持 0.1.3 里程碑结果的前提下，完成两个直接影响“接近原生 OpenCode web 体验”的缺口：

1. 让 relay 能正确显示**多工作区** session，而不是只显示当前主工作区（例如 `D:\CODE`）的会话。
2. 让 Tailnet 浮标不再成为干扰原生 UI 的长期负担。

## 当前问题

### 1. 多工作区 session 覆盖不完整

当前 relay 的目录发现模型仍然过于依赖：

- `GET /session?limit=N` 的最近会话窗口
- `latestSession.directory`
- `meta.sessions.directories`

这会导致：

- 热门工作区（如 `D:\CODE`）被优先看见
- 较旧或不在最近窗口里的其他工作区（如 `E:\code`）不进入浏览器项目视图

换句话说，relay 现在是“从最近 session 推断 workspace”，而原生更接近“从 project/worktree 视角展开 session”。

### 2. Tailnet 浮标仍然是体验负担

即使已经移到顶部，浮标本质上仍是一个叠加层。

从产品视角，这个浮标在正常 `live` 状态下不应长期存在，因为它仍然会干扰：

- 搜索栏
- 标题区
- 原生 OpenCode 的视觉洁净度

## 核心判断

### A. workspace 视角应成为 0.1.4 的主事实来源

0.1.4 不能继续靠“最近 session 的目录集合”去代表工作区集合。

最小正确模型是：

> relay 用 `project/worktree` 作为工作区真相来源，
> 再按每个工作区去拉 `roots=true` 的 session 列表。

也就是说，工作区应该来自**project inventory**，而不是来自“最近 80 条 session 刚好落到了哪些目录”。

### B. 浮标应该从“默认显示”改成“异常才显示”

0.1.4 不需要做复杂拖拽浮标。

最小正确策略是：

> 在 `live` 状态默认隐藏，
> 仅在 `stale / protected / offline / error` 这些非正常状态时自动出现。

这样既保留诊断价值，又不长期污染原生 UI。

## 0.1.4 最小修复路径

### 1. Project inventory 进入 relayer 真相层

relayer 不再只看：

- `session list`
- `latest directory`

而要新增：

- `GET /project`

把 upstream 的 project/worktree/sandboxes 变成 relay 的工作区真相源。

### 2. 按每个工作区独立拉 roots 列表

一旦有了 project inventory，relay 就按每个工作区目录去拉：

- `/session?directory=<dir>&roots=true&limit=N`

这样工作区是否可见，不再取决于它最近有没有出现在全局 session 前 80 条里。

### 3. 浏览器 seed 从“覆盖最近目录”改成“合并工作区视图”

当前 `seed(meta)` 会用 `meta.sessions.directories` 覆盖浏览器里的 project 视图。

0.1.4 要把它改成：

- 使用 relay 的 project inventory / worktree 集合
- merge，而不是 overwrite
- `lastProjectSession` 按 root/worktree 维度维护，而不是只写一个 latest directory

### 4. 浮标策略改成状态驱动可见性

0.1.4 的浮标策略：

- `live`：隐藏
- `syncing / stale / protected / offline / error`：显示

这不需要 draggable，先把“碍事”这个问题彻底消掉。

## 不做什么

0.1.4 明确不做：

- 不继续加可拖拽浮标
- 不做新壳层 UI
- 不碰 launcher 主职责
- 不靠 fork / plugin / patch upstream
- 不继续拿“最近 session 目录”充当工作区真相

## 验收标准

### A. 多工作区覆盖

在同一 target 上：

- `D:\CODE`
- `E:\code`

这类不同工作区都能在 relay 页面中出现，不需要手动清缓存或切换技巧。

### B. Load more 不退化

按每个工作区拉 `roots=true` 之后：

- `加载更多` 仍然要有效
- 不允许重新退回 stale 55-item fallback 模型

### C. 浮标不打扰

- 正常 `live` 状态下默认看不到 Tailnet 浮标
- 非正常状态时能看到状态提示

### D. 真人路径通过

从 landing page 开始：

1. 输入 host/port
2. 点 Open
3. 进入 session 页面
4. 确认：
   - 多工作区可见
   - `加载更多` 可用
   - 历史消息可用
   - 浮标不遮挡正常 UI

## 最后定义

如果 `0.1.3` 的主题是“把 relay 从不能用修回能用，并开始逼近原生启动体验”，

那 `0.1.4` 的主题就是：

> **把 relay 的工作区视图从“最近 session 推断”升级成“真实 project/worktree 视图”，并把 Tailnet 状态提示降级为非打扰式存在。**
