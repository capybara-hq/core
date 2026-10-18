# Capybara 设计系统规格（E · 终端）

> 状态：已实现（`packages/design` + `/dev/ui`）· 2026-10-18
> 视觉参考：设计画布 https://claude.ai/artifact/KsyGe4akVT4KbqUHfHXdXd （"E · 设计系统" 两行，深 / 浅）
> 视觉真值：`/dev/ui` 目录页与入库的截图基准（`apps/web/visual/`，Linux 版）；`docs/design/reference/`（画布导出）暂缺，导出后再补

本文是 Web 界面的**唯一规范**。画布与截图是对本文的图示；两者不一致时以本文为准，并修正画布。
实现位于 `packages/design`（包名 `@capybara-hq/design`），`apps/web` 只消费它。能自动检查的规则以 `pnpm check` 与截图测试为准（见 §9）。

规范用词：**必须** / **不得** 为强制；**应** 为默认做法，偏离须在评审中说明理由。

---

## 1. 设计原则

1. **字符网格**：全站一款等宽字体，中文一字恰为英文两格，界面在字符网格上对齐。
2. **克制**：直角、1px 线、灰阶为主；主色只承担 §2.3 列出的五种职责。
3. **高密度、可扫读**：数字等宽右对齐，状态用「符号 + 颜色 + 文字」三重编码。
4. **结构先于样式**：页面由 App Shell（§4）与页面模板（§5）组成，页面不自行布局外壳。
5. **深色优先，深浅同源**：两套主题共享同一组 token 名，只换值。

---

## 2. Token

所有颜色、尺寸、阴影只能通过 token 使用：`packages/design/src/styles/tokens.css` 中的 CSS 变量 `--cb-<token>`，深色值挂在 `:root[data-theme="dark"]`，浅色值挂在 `:root[data-theme="light"]`。颜色字面量只允许出现在 `tokens.css`。不使用 Tailwind。

### 2.1 颜色

| Token | 深色 | 浅色 | 用途 |
|---|---|---|---|
| `bg` | `#0A0A0A` | `#F6F6F3` | 页面底色 |
| `panel` | `#121211` | `#FFFFFF` | TopBar、StatusBar、ActionRow、浮层、Inspector 卡片 |
| `hover` | `#161614` | `#ECECE7` | 悬停底色、禁用输入底色、骨架 |
| `line` | `#262624` | `#D6D6D0` | 默认 1px 线、分隔、输入框边 |
| `line-strong` | `#3A3A37` | `#B5B5AE` | 浮层边框、ActionRow 上边线、悬停边框、未选复选框 |
| `ink` | `#E6E6E3` | `#0A0A0A` | 正文 |
| `muted` | `#8E8E89` | `#5E5E5A` | 次要文字、表头、标签 |
| `faint` | `#5A5A56` | `#9A9A94` | 占位符、禁用文字、分隔符号（**不得**承载必要信息，对比度不足 4.5:1） |
| `accent` | `#FF6A13` | `#CC4609` | 主色（§2.3） |
| `accent-hover` | `#FF8240` | `#B83F08` | 实心主按钮悬停 |
| `accent-press` | `#E85A08` | `#A33707` | 实心主按钮按下 |
| `on-accent` | `#0A0A0A` | `#FFFFFF` | 主色实心底上的文字 / 图标 |
| `accent-tint` | accent @ 12% | accent @ 12% | 选中行 / 项底色 |
| `ok` | `#3FD483` | `#16803F` | 成功、上涨 |
| `fail` | `#FF5C52` | `#C8302A` | 失败、错误、危险、下跌 |
| `warn` | `#F2C14B` | `#8F6500` | 待审批、未保存、警告 |
| `scrim` | `rgba(0,0,0,.60)` | `rgba(10,10,10,.25)` | 对话框遮罩 |

浅色主色取 `#CC4609`：白字对比度 4.72:1（WCAG AA）。原 `#FF6A13` 配白字仅 2.87:1，不得用于浅色主题。

### 2.2 字体与字号

- 字体：**更纱等宽黑体 SC**（Sarasa Mono SC，OFL-1.1），字重仅 400 / 700。全站唯一字体，不得引入第二款。
- 交付：构建期子集化为 woff2（ASCII + 一级常用汉字 3755 字 + 界面实际用字 + 符号表），自托管，`font-display: swap`。
- 回退：`'Sarasa Mono SC', ui-monospace, monospace`。

| 名称 | 字号 / 行高 | 字重 | 用途 |
|---|---|---|---|
| `h1` | 20 / 28 | 700 | PageHeader 标题 |
| `h2` | 16 / 24 | 700 | 区块标题、Dialog 标题 |
| `body` | 13 / 20 | 400 | 默认正文、表格、控件 |
| `small` | 12 / 16 | 400 | 表头、帮助文字、错误信息、StatusBar |
| `micro` | 11 / 14 | 400 | PageHeader 指标标签 |

- 数字一律 `font-variant-numeric: tabular-nums`。
- 不使用斜体、不使用字距调整（等宽网格）。

### 2.3 主色的五种职责（仅此五种）

| 形态 | 用于 |
|---|---|
| 实心（`accent` 底 + `on-accent` 字） | 视图内**唯一**的主操作 |
| 描边（1px `accent` 边 + `accent` 字） | 需强调的次级操作、选中的分段、当前页码 |
| 下划线（`inset 0 -2px 0 accent`） | 当前一级导航、当前 PageTab |
| 文字（`accent` 字 / `●`） | 正在发生：运行中、实时、自动刷新倒计时、光标 |
| 底色 + 左标（`accent-tint` 底 + `inset 2px 0 0 accent`） | 选中的行 / 项 / 锚点 |

其余地方不得使用主色。涨跌只用 `ok` / `fail`。

### 2.4 状态编码

| 状态 | 符号 | 颜色 | 文案 |
|---|---|---|---|
| 运行中 | `●` | accent | 运行中 |
| 成功 | `✓` | ok | 成功 |
| 失败 | `✗` | fail | 失败 |
| 待审批 / 暂停 | `‖` | warn | 待审批 |
| 排队 | `○` | muted | 排队 |
| 已取消 | `⊘` | muted | 已取消 |

状态必须同时有符号与文字，不得只靠颜色。

### 2.5 尺寸、线、圆角、阴影、层级、动效

- 间距：4 的倍数（4 / 8 / 12 / 16 / 24 / 32 / 40）。
- 控件高：24（表格内、紧凑）/ **28（默认）**/ 36（页面级强调）。图标按钮为正方形。
- 线：1px；圆角：**0**（全站）。
- 阴影只用于浮层：

| Token | 深色 | 浅色 | 用于 |
|---|---|---|---|
| `shadow-1` | `0 8px 24px rgba(0,0,0,.40)` | `0 2px 8px rgba(10,10,10,.08)` | Menu、Popover、Toast、行内菜单 |
| `shadow-2` | `0 16px 48px rgba(0,0,0,.50)` | `0 8px 24px rgba(10,10,10,.12)` | Dialog、命令面板 |
| `shadow-sheet` | `-16px 0 40px rgba(0,0,0,.40)` | `-4px 0 16px rgba(10,10,10,.08)` | Sheet |

- 层级：Sheet 40 · Dialog 50 · Popover/Menu 60 · Toast 70。
- 动效：120ms，淡入 + 4px 位移，`ease-out`，无弹性；尊重 `prefers-reduced-motion`。
- 焦点环：控件 `outline: 2px solid accent; outline-offset: 2px`；表格行 / 列表项 `outline: 1px solid accent; outline-offset: -1px`。仅 `:focus-visible`。

---

## 3. 品牌元素

- **Logo**：像素水豚，14×10 位图，以 2px（TopBar）/ 3px（空状态）/ 6px（认证页）为像素单位绘制，`shape-rendering: crispEdges`，主色填充。位图（`X` 为实心，`O` 为眼睛镂空）：

```
..........X...
.........XXX..
...XXXXXXXXXXX
..XXXXXXXXXOXX
.XXXXXXXXXXXXX
.XXXXXXXXXXXXX
.XXXXXXXXXXXX.
..XXXXXXXXXX..
..XX..X..XX...
..XX..X..XX...
```

- 字标：`CAPYBARA`，700，与 Logo 间距 8。
- **抖动点阵**：只用于认证页两侧背景与（可选）概览页页头角落，方块 4px，密度由一侧向另一侧递减，可点缀 ≤1% 主色方块。其他页面不得使用。
- 不使用插画、渐变、毛玻璃、emoji。

---

## 4. App Shell（系统布局）

每个页面自上而下固定为以下层，顺序不可变（认证页除外，见 §5 T10）：

| 层 | 高 | 是否必有 | 内容 |
|---|---|---|---|
| TopBar | 40 | 必有 | Logo · 组织 / 环境切换 · 一级导航 · ⌘K 搜索 · 账户 |
| PageHeader | 56 | 必有 | 单行：`父级 /` 标题 + 计数·状态 ｜ 关键指标 ≤5 ｜ 操作 |
| PageTabs | 36 | 可选（仅详情类） | 页内标签，当前项下划线 |
| Body | 自适应 | 必有 | §4.3 五种布局之一 |
| ActionRow | 40 | 可选 | 有待提交改动时出现，叠在 StatusBar 上方 |
| StatusBar | 24 | 必有 | 上下文路径 · 页面状态 ｜ 系统状态 · 版本 |

### 4.1 TopBar
- 底色 `panel`，下边线 `line`。
- 一级导航：概览 · Agents · 运行记录 · 审批 · 知识库 · 插件 · 设置（以产品实际为准，顺序固定）。当前项 `ink` + 主色下划线，其余 `muted`。
- ⌘K 输入框宽 220，前缀 `>`，后缀 `⌘K`。

### 4.2 PageHeader
- 单行，高 56，左右内边距 16。一级页面与二级页面高度一致。
- 左：父级路径（`muted`，13px，可点击）+ ` / ` + 标题（`h1`）+ 计数 / 状态（13px）。一级页面只有标题。
- 中：关键指标 ≤5，每项「标签（micro, muted）/ 数值（700）」，项间 1px `line` 竖线。
- 右：操作，≤ 1 个实心主操作 + 2 个次级 + `⋯` 菜单；主操作在最右。表单类页面的提交操作**不得**放这里，放 ActionRow。
- 有 PageTabs 时 PageHeader 不画下边线，由 PageTabs 下边线收口。

### 4.3 Body 的五种布局

| 布局 | 结构 | 用于 |
|---|---|---|
| Single | Content | 概览、链路查看器、系统状态、首次使用 |
| Rail + Content | 240 + 自适应 | 列表 |
| Content + Inspector | 自适应 + 400 | 详情、调试台 |
| Rail + Content + Inspector | 240 + 自适应 + 400 | 收件箱 |
| Centered | 锚点导航 180 + 内容最大 760，整体最大 960 居中 | 表单、设置、向导 |

- Content 最小宽 560。Rail 可折叠；Inspector 可关闭。
- 滚动：TopBar / PageHeader / PageTabs / ActionRow / StatusBar 固定；Rail、Content、Inspector 各自独立滚动；页面级不得出现第二条横向滚动条（宽表格在自身容器内横向滚动）。
- 响应式：< 1280 Inspector 改为右侧 Sheet；< 960 Rail 改为工具栏「筛选」按钮 + Sheet；< 640 PageHeader 指标折叠进 `⋯`。

### 4.4 ActionRow 与 StatusBar
- **StatusBar 只有一种形态**：24 高，底色 `panel`，上边线 `line`，`small` 字号 `muted`。左：`> 用户@组织:路由` · 页面状态（如「已筛选 18 / 24」「自动刷新 15s」）；右：`●` 系统状态 · 版本 · 时区。
- **ActionRow**：页面存在待提交改动（表单、批量编辑、审批决策、向导）时出现在 StatusBar **上方**，StatusBar 不变。高 40，底色 `panel`，上边线 `line-strong`，与 StatusBar 之间 1px `line`。左：`‖ N 处未保存`（warn）`· N 处错误`（fail）；右：取消（ghost）· 次操作（default）· 主操作（primary，最右）。
- 页面不得另造悬浮 / 固定的底部按钮条。
- 页面通过 `useStatusBar(...)` 写入「页面状态」文案（由 AppShell 的 StatusBar 渲染）；StatusBar 与 ActionRow 是 design 组件，页面不直接渲染 StatusBar。

---

## 5. 页面模板

新页面**必须**选用以下模板之一；需要新模板时先扩展本节并经评审。

| # | 模板 | Body | PageTabs | ActionRow | 典型页面 |
|---|---|---|---|---|---|
| T1 | 概览 Overview | Single | — | — | 组织首页、Agent 概要 |
| T2 | 列表 List | Rail + Content | — | 批量编辑时 | Agents、知识库、插件、成员 |
| T3 | 详情 Detail | Content + Inspector | 有 | — | Agent、知识库、插件详情 |
| T4 | 表单 Form | Centered | — | 始终（提交操作） | 新建 / 编辑 Agent |
| T5 | 设置 Settings | Rail（二级导航）+ Centered | — | 有改动时 | 组织、环境、安全、计费 |
| T6 | 收件箱 Inbox | Rail + Content (+ Inspector) | — | 决策时 | 人工审批、告警处理 |
| T7 | 调试台 Playground | Content + Inspector | — | — | 对话试运行 Agent，右侧实时链路 |
| T8 | 链路查看器 Trace | Single（上：Span 瀑布，下：Span 详情） | — | — | 单次运行详情 |
| T9 | 向导 Wizard | Centered + 步骤条 | — | 始终（上一步 / 下一步） | 首次接入模型、连接器、插件 |
| T10 | 认证 Auth | 无 Shell，居中卡片 + 两侧抖动点阵 | — | — | 登录、找回密码、接受邀请、初始化 |
| T11 | 系统状态 | Single 居中 | — | — | 404、403、维护中、未开通 |
| T12 | 首次使用 Onboarding | Single 居中清单 | — | — | 新组织、空环境 |

### 5.1 列表（T2）
- Rail：分面筛选，每组标题（muted）+ 复选项 + 计数（faint）。
- Content = 一个 DataTable（§6.6），其工具栏、批量栏、分页均属于 DataTable。
- PageHeader：标题 + 总数，指标 ≤4，右侧次操作 + 新建（主）。
- StatusBar 页面状态：筛选结果数。

### 5.2 详情（T3）
- PageHeader：`父级 /` 名称 + 版本（faint）+ 状态；指标 ≤4；操作：编辑（default）、试运行（secondary）、`⋯`。
- PageTabs：概要 · 运行 · 配置 · 版本 · 权限 · 审计（按对象类型取舍），计数用 faint 跟随。
- Content：卡片式区块（1px `line` 外框，区块头 h2 + 右侧操作），区块间距 16。
- Inspector：分组属性，组标题 small muted，键 8ch 宽 muted，值单行省略。

### 5.3 表单（T4）
- PageHeader：`父级 /` 新建 X + 草稿徽标；右侧只放辅助操作（如「从 YAML 导入」）。
- 锚点导航：当前项主色左标；含错误的分组后缀 `●`（fail）。
- 分组：两栏网格 `220px | 1fr`，左为组标题（700）+ 说明（small muted），右为字段；组间 1px `line` 上边线，上下内边距 20。
- 字段：标签在上（必填标 `*` 主色、可选标「可选」faint）；控件 28 高；帮助文字与错误信息在下（small）；错误时边框 `fail` 并以 `✗` 开头给出可执行建议。
- ActionRow 始终存在：取消 · 保存草稿（⌘S）· 发布。

---

## 6. 组件

所有组件提供：默认、悬停、按下（如适用）、焦点、禁用、加载（如适用）状态，深浅两套。

### 6.1 Button

| 变体 | 默认 | 悬停 | 按下 | 用途 |
|---|---|---|---|---|
| primary | `accent` 底，`on-accent` 字，700 | `accent-hover` 底 | `accent-press` 底 | 视图唯一主操作 |
| secondary | 透明底，1px `accent` 边与字 | `accent-tint` 底 | accent @ 20% 底 | 需强调的次操作 |
| default | 透明底，1px `line` 边，`ink` 字 | `line-strong` 边 + `hover` 底 | `line` 底 | 普通操作 |
| ghost | 无边，`muted` 字 | `hover` 底 + `ink` 字 | `line` 底 | 取消、低优先级 |
| danger | 透明底，1px `fail` 边与字 | fail @ 12% 底 | fail @ 20% 底 | 危险操作入口 |
| danger-solid | `fail` 底，`on-accent` 字 | — | — | 仅危险确认对话框中、确认条件满足后 |

- 禁用：`faint` 字，`line` 边（primary 为 `line` 底），`cursor: not-allowed`。
- 加载：文案前加旋转字符 `⠿`，保持宽度，不可重复点击。
- 尺寸 24 / 28 / 36，水平内边距 8 / 12 / 16。快捷键提示以 `⌘S` 形式跟在文案后。

### 6.2 Input / Select / Textarea / Stepper
- 高 28，内边距 0 8，1px `line` 边，透明底。
- 悬停 `line-strong` 边；聚焦 `accent` 边 + `0 0 0 1px accent` 外环；错误 `fail` 边；禁用 `hover` 底 + `faint` 字。
- 前缀 / 后缀用 `faint` / `muted`（如 `>`、`⌘K`、`▾`）。
- Textarea 带字数时右下角 `n / max`（faint）。
- 代码类输入（提示词）用带行号的编辑区：行号列 `faint` + 右边线。
- Stepper：`− 值 +`，两侧 28 宽按钮。
- Slider：离散方块轨道（默认 20 格，格宽自适应、格间距 2、高 8），已选部分 `accent`，其余 `line`；拇指为 4×16 `ink` 竖条；键盘 ←→ 按步长、PageUp/PageDown 按 10 步；可与右侧数值输入框（宽 8ch）联动。未设置值时拇指居中且轨道全为 `line`，不冒充某个取值。
- 恢复默认：字段被用户设置过时，标签行右侧出现 ghost 小链接「↺ 恢复默认」（small），点击清除该值并回到默认显示。

### 6.3 Checkbox / Radio / Switch / 选项卡片
- 全部方形 14×14。复选框选中：`accent` 底 + `on-accent` 的 `✓`；半选 `–`。单选选中：`accent` 边 + 6×6 `accent` 内方块。
- Switch：28×16 轨道 + 10×10 方形滑块；开：`accent` 轨 + `on-accent` 滑块靠右。
- 选项卡片（单选的富选项）：1px `line` 边；选中 `accent` 边 + `accent-tint` 底。

### 6.4 Tabs / Segmented / Pagination
- Tabs：文字 + 选中下划线（§2.3）；悬停 `hover` 底；禁用 `faint`。
- Segmented：相邻按钮共边，高 24；选中描边主色。
- Pagination：`1–50 / 1,284` · 每页 N ▾ · `‹ 上一页` 页码 `下一页 ›`；当前页描边主色。

### 6.5 Badge / Kbd / Tooltip / 指标
- Badge：1px `line` 边，small，左右 6；强调版描边主色；计数版 `ink` 底 `bg` 字。
- Kbd：1px `line` 边 + 2px 下边。
- Tooltip：`panel` 底 + `line-strong` 边，small，延迟 400ms。
- 涨跌：`▲8.2%`（ok）/ `▼1.1s`（fail）。
- KeyValue：键值对列表（Inspector 属性组、详情区块）；键 muted 固定 8ch 宽，值单行省略。

### 6.6 DataTable
结构（自上而下，同一外框 1px `line`）：工具栏 / 批量操作栏 → 表头 → 行 → 分页。

- 工具栏：搜索（`/` 聚焦）、已应用筛选（default 按钮样式，带 `✕`）、清除全部、排序、视图切换、列设置。高 40，24 / 28 高的控件在其中垂直居中（上下内边距 6，由居中推得，不是自由间距值），与批量操作栏等高，原位替换时不跳动。
- 外框：默认 `framed`（1px `line` 外框）；嵌入 Card 或贴边铺满内容区时用 `framed={false}` 去掉外框。
- 批量操作栏：勾选 ≥1 行时**原位替换**工具栏，高 40，`panel` 底，左「已选 N 项」（700）+ 批量操作（24 高），右「取消选择 Esc」。不得使用主色边框或底色。
- 表头：small，muted；正在排序的列 `ink` + `▼`/`▲`；可排序列悬停出 `↕` 与 `hover` 底；下边线 `line`。
- 行：默认高 32（紧凑 28，带缩略图 44），单元格内边距 6 8，行间 1px `line`。
- 对齐：数字、耗时、金额右对齐；ID、时间左对齐；ID 与时间用 `muted`。超长单行省略，悬停以原生 `title` 显示全文（每格一个 Tooltip 过重）。
- 行状态（同时出现时优先级从高到低）：焦点环 > 选中 > 勾选 > 悬停 > 默认。
  - 悬停：`hover` 底；复选框边变 `ink`。
  - 选中（打开详情 / Inspector）：`accent-tint` 底 + 左侧 2px 主色。
  - 勾选：仅复选框变主色，行底不变。
  - 焦点：内描边 1px 主色。
  - 禁用 / 归档：整行 `faint`，不可勾选。
- 行内菜单 `⋯`：≤5 项，危险项置底并以分隔线隔开；打开时 `⋯` 底色 `line`。菜单 `panel` 底 + `line-strong` 边 + `shadow-1`。
- 展开行：`panel` 底，缩进与 `└` 引导，显示摘要（如执行链路前几步）。
- 空状态：
  - 加载：骨架行（`hover` / `line` 色条），不用转圈。
  - 空（首次）：像素 Logo（`line-strong`）+ 一句说明 + 下一步主操作。
  - 无结果（筛选导致）：`∅` + 说明当前筛选 + 「清除筛选」。
  - 错误：外框 `fail`，`✗ 加载失败` + 错误码 · 请求 ID + 「↻ 重试」。
- 键盘：↑↓ 移动焦点，空格勾选，↵ 打开，Esc 取消选择。
- 表头吸顶；横向滚动时首列吸左。

### 6.7 浮层

选择规则：需要用户决定 → Dialog；查看 / 编辑一个对象且不离开列表 → Sheet；就地选项 / 筛选 → Popover / Menu；操作结果反馈 → Toast（不得用 Dialog）；超过 6 个字段的新建 → 表单页（T4）。

- **Dialog**：宽 480 / 640，`panel` 底 + `line-strong` 边 + `shadow-2` + `scrim`。头（h2 标题 + 关闭 ✕）/ 体（内边距 16）/ 尾（右对齐：ghost 取消 + 主操作，主操作带 `↵`），头尾 1px `line` 分隔。Esc 关闭；焦点锁定并在关闭后归还。默认焦点：普通对话框在主操作，危险对话框在取消。
- **危险确认**：外框 `fail`，标题 `fail`；说明后果与可恢复性；需输入对象名称，匹配前确认按钮禁用，匹配后为 danger-solid。
- **Sheet**：右侧滑出，宽 480 / 720，`panel` 底 + 左边线 `line-strong` + `shadow-sheet`；默认无遮罩（列表仍可操作）。头：名称 + 版本 + 在新页打开 `↗` + 关闭 `✕`；可含 Tabs；尾：操作。存在未保存修改时关闭需二次确认。
- **链接**：design 包与框架无关，TopBar 导航、PageHeader 父级、Tabs、Sheet 的链接通过 `DesignProvider` 的 `link` 组件渲染（默认 `<a>`）；`apps/web` 传入 next-intl 的 `Link`，以获得客户端导航与语言前缀。页面不要自己拼 `<a href>` 做站内跳转。
- **Popover / Menu**：`panel` 底 + `line-strong` 边 + `shadow-1`；筛选 Popover 顶部为搜索 `>`，底部「清除 / 应用 ↵」；悬停项 `hover` 底。触发按钮在打开且有值时描边主色。
- **命令面板（⌘K）**：宽 560，`>` 前缀输入；分组标题 small faint；当前项 `accent-tint` 底 + 左标；底部键位提示。
- **Toast**：右下角堆叠，`panel` 底 + `line-strong` 边 + `shadow-1`，左侧 2px 状态色（ok / accent / fail）；成功 4s 自动消失；错误需手动关闭并可附「查看 →」；进度型带分段进度条。

### 6.8 图表
- 柱状图用离散方块堆叠（像素风），`line-strong` 为常规值，`fail` 标出失败数，当前时段用主色。
- 迷你趋势 Sparkline（表格内）：12 根 4px 宽方柱，`muted`。
- 柱状图的 `fail` 是 `value`（总数）的子集：柱高 = 总数，失败数画在柱顶的块上。
- 坐标标签 small faint；不画网格线。

---

## 7. 文案与国际化
- 所有界面文案走 next-intl；中英两套。给模型看的文案（提示词、工具描述）一律英文，表单中提示词字段需注明。
- 数字千分位；耗时 `6.8s` / `41.2s` / `00:00:18`；金额 `¥412.80`；相对时间（「2 小时前」）用于列表，绝对时间（`10-18 14:02:11`）用于记录与日志。
- 错误信息说明原因并给出可执行的下一步；附错误码与请求 ID 以便排查。

## 8. 可访问性
- 文字对比度 ≥ 4.5:1（`faint` 仅用于非必要信息）。
- 所有交互元素为原生 `button` / `a` / `input`；图标按钮必须有 `aria-label`；状态不只用颜色表达。
- 完整键盘可达，焦点可见（§2.5）；浮层焦点锁定与归还。
- 尊重 `prefers-reduced-motion` 与 `prefers-color-scheme`（默认深色，用户可切换）。

## 9. 落实与验收（如何保证实现与本规格一致）

1. **包边界**：`apps/web` 只能从 `@capybara-hq/design` 引入 UI 组件与模板。导入规则是**黑名单**：`@radix-ui/*`、`cmdk`、CSS-in-JS（`@emotion/*`、`styled-components`、`@stitches/*`、`@vanilla-extract/*`、`styled-jsx`）、组件库（`@mui/*`、`@chakra-ui/*`、`@mantine/*`、`@headlessui/*`、`antd`）、`tailwindcss` / `tailwind-merge`、类名工具（`clsx`、`classnames`、`class-variance-authority`）、图标库（`lucide-react`、`react-icons`）一律不得导入；`.css` 只允许导入 `@capybara-hq/design/styles.css`。黑名单随新增的样式类依赖扩充。
2. **模板强制**：`apps/web/src/app` 下每个 `page.tsx` 必须渲染从 `@capybara-hq/design` 导入的 §5 模板之一（识别别名与命名空间导入）；Shell 各层只由模板渲染。两处豁免：开发用目录页 `app/[locale]/dev/**`；以及只负责 404 的 page（不含任何 JSX、调用 `next/navigation` 的 `notFound()`，如 `[...rest]/page.tsx`），其页面由同段 `not-found.tsx` 的 StatusPage 渲染。
3. **样式归属**：`apps/web/src` 中不得出现 `className` / `class` / `style` / `dangerouslySetInnerHTML` 属性（含展开属性与 `createElement` / `jsx` 调用）、`<style>` 元素、`.css` 文件、任何颜色字面量（`#hex`、`rgb()`、`hsl()`、`oklch()`、`color-mix()` 等）；页面内的排版只能用 design 包的布局原语（`Stack`、`Grid`、`Card`、`Text`）。`packages/design` 中颜色字面量只允许出现在 `tokens.css`。
4. **组件目录页**：`/dev/ui` 用固定假数据渲染每个组件的全部状态与每个模板页，深浅两套。
5. **截图回归**：Playwright 对目录页截图并与基准比对，差异即失败；入库基准只含 Linux 版，在固定的 Playwright Docker 镜像中由 `visual-update` 工作流生成（CI `visual` job 用同一镜像）；本地（darwin）截图被 gitignore，仅供本地对照；更新基准须在 PR 中附差异图并经确认。
6. **首次验收**：对照页左侧为画布基准图、右侧为真实截图，逐张由产品确认后锁定基准。
7. **评审清单**：每个界面 PR 对照本规格检查模板选用、主色用法、状态编码与 ActionRow 规则。

第 1–3 条由 `pnpm check` 检查，每条检查附违规样例测试。

## 10. 变更流程
新增组件、模板或 token：先改本规格与画布 → 评审确认 → 在 `packages/design` 与 `/dev/ui` 实现 → 更新基准截图。页面中不得临时造新模式。
