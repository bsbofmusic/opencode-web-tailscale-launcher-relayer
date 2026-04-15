# Tailnet Relayer 0.1.3 Cold-Start Design

## 目标

把当前 relayer 从“功能正确但冷启动明显慢于原生”推进到“冷启动时的前端初始化更接近原生 OpenCode web”。

这不是继续 patch 某一个接口，而是定义一套新的 **cold-start boot profile**。

## 当前问题

当前版本已经恢复了：

- 入口可用
- 页面不白屏
- session 列表可用
- `加载更多` 可用
- 历史消息可用

但冷启动时仍然存在明显差距：

- 原生页面在几百毫秒内就能进入完整初始化
- relay 页面需要数秒甚至十余秒，才把 project / current session / 历史消息逐步补齐

这说明当前问题已经不再是功能问题，而是 **前端初始化契约不完整**。

## 核心判断

当前 relay 页面不是拿到一个“接近原生”的初始化状态，而是依赖浏览器和后端在页面打开后慢慢补齐：

1. 先识别 server
2. 再识别 project
3. 再识别 current session
4. 再拉 roots list
5. 再拉 message history

所以冷启动看起来慢，不是因为某一个接口完全坏了，而是因为：

> **relay 页面拿到的是“最小能跑”的状态，而不是“最小接近原生”的状态。**

## 0.1.3 的架构主线

### 从“页面打开后补状态”改成“页面打开前注入最小 boot profile”

`0.1.3` 的方向不是继续 patch 请求时序，而是：

> 在浏览器真正进入 session 页面前，relayer 就把那组最关键的前端初始化状态准备好。

这组状态必须足够小，避免重新发明一套上游 app；
但也必须足够完整，避免页面还要花数秒自己摸索当前 project / current session。

## 冷启动 boot profile 的最小状态集

### A. 当前 server 识别

必须保证页面一进来就知道：

- 当前 server 是谁
- 默认 server 是谁

这是当前已经存在的基础层，继续保留：

- `opencode.global.dat:server`
- `opencode.settings.dat:defaultServerUrl`

### B. 当前 project 识别

必须保证页面一进来就知道：

- 当前 project / workspace 是哪个
- 当前目录对应的是哪个项目上下文

这是当前 relay 版本仍不完整的一层。

### C. 当前 session 识别

必须保证页面一进来就知道：

- 当前 session id
- 当前 session 所在目录
- 当前 project 对应的 last session

这是把“先看到 session 页面壳子”推进到“直接进入正确 session 状态”的关键。

### D. 当前 session 的最小消息快照

不需要把所有历史都提前注入浏览器，
但至少要让页面一进来就能拥有一份：

- current session `message(limit=80)` 的可直接消费数据

这能避免页面在最脆弱的第一屏还要等一次慢请求才开始显示真正内容。

### E. 当前 project 的最小 current-project 状态

至少要让页面不必再单独猜测：

- 当前 project 的 current project payload

## 不做什么

`0.1.3` 明确不做：

- 不 patch 上游源码
- 不做 fork
- 不做 plugin runtime
- 不在浏览器里自己重建完整 app store
- 不把整个 roots list / 全量 message 都塞进 localStorage

也就是说：

> 0.1.3 做的是“最小必要状态注入”，不是“复制一个 OpenCode 前端状态机”。

## 注入点

### 注入时机

不是 session 页面加载完成后，
而是 **landing -> launch -> final session** 这一跳完成之前。

### 注入位置

优先顺序：

1. `launchPage(initial)` 里写入 boot profile
2. final session HTML 返回前，通过 relayer 注入一段 very small bootstrap state script

原则：

- 数据由 relayer 决定
- 页面只负责消费
- 不让浏览器再自己花很久补关键状态

## 与 0.0.12 的关系

`0.0.12` 的稳定不变量仍然保留：

- 先进入最终 session 页面
- 不在首屏关键路径里引入过多 relayer 逻辑

`0.1.3` 只是在这个稳定入口之上，补上一层更接近原生的 boot profile。

所以它不是推翻 `0.0.12`，而是：

> **在 0.0.12 的稳定入口上，把冷启动初始化从“最小能跑”升级到“最小接近原生”。**

## 验证方式

### 第一层：API 验证

验证 relayer 能在进入前稳定拿到：

- `global/config`
- `project/current`
- current session `message(limit=80)`
- latest roots list

### 第二层：浏览器存储验证

验证 final session 页面打开后，浏览器里已经存在 boot profile 需要的关键状态。

### 第三层：真人路径验证

从 landing page 开始：

1. 输入 host/port
2. 点 Open
3. 进入 session 页面

验收指标：

- `roots` 出现时间
- `project/current` 出现时间
- current session `message` 出现时间
- “加载更早的消息” 出现时间

### 第四层：原生对照验证

同一 session，对照原生直连与 relay：

- 入口后一秒内页面状态
- 三秒内页面状态
- 十秒内页面状态

目标不是立刻追平每一个毫秒，
而是确认 relay 的初始化形态越来越接近原生，而不是靠慢慢补齐。

## 成功标准

`0.1.3` 成功不再只看“页面能打开”，而看：

1. 当前 session 在首轮就能更快被认出
2. `message/project/roots` 的首轮等待明显缩短
3. 真人路径下，页面不再经历长时间“壳子先出来、内容慢慢补”的阶段
4. 不破坏当前已经恢复好的：
   - 页面可打开
   - session 列表可用
   - `加载更多` 可用
   - 历史消息可用
   - target 边界可解释

## 最后的定义

如果 `0.1.2` 是把 relayer 从“不能用”修回“能用”，
那 `0.1.3` 的任务就是：

> **把 relay 的冷启动体验，从“功能正确但初始化缓慢”，推进到“最小状态充分、接近原生 OpenCode 的前端启动形态”。**
