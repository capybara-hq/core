# 设计系统遗留事项（写后续计划时对照）

来源：设计系统分支（`feat/design-system`）子代理执行记录中各任务审查推迟处理的轻微问题（`.superpowers/sdd/2026-10-18-design-system/deferred-minors.txt`）。合并前清理（A 视觉 6 项、B 行为 11 项）已修掉的条目不在此列，见文末「合并前已处理」。

每条格式：**做什么** — 在哪里 — 为什么推迟。

## 有意保留的行为差异（不改）

- **ModelParams 与旧实现的差异按 spec §6.2 有意为之**：清空数值框不再「取消设置」（失焦恢复上一次有效值，取消设置走「恢复默认」）；数值按步长小数位取整并夹到 [min, max]；未设置的 Switch 不再显示「默认」提示。— `apps/web/src/components/ModelParams.tsx`、`packages/design/src/controls/{inputs,slider,number-draft}.ts(x)` — 规范要求数值输入只产出合法值，「恢复默认」是唯一的取消入口；记录在此以免被当成回归。

## 组件与样式

- **token 只定义在 `:root[data-theme]` 下，缺属性时无回退** — `packages/design/src/styles/tokens.css` — 布局（`apps/web` 根 layout）与目录页总会设置 `data-theme`，实际不会缺；加回退需要决定默认主题与 `prefers-color-scheme` 的关系，留到主题设置功能一起做。
- **`react` / `react-dom` 放在 `dependencies` 而不是 `peerDependencies`** — `packages/design/package.json` — 目前只有工作区内的 `apps/web` 消费，版本一致不会出问题；对外发布前改为 peer（并在 devDependencies 保留一份）。
- **`useDesignT` 返回的闭包没有 memo** — `packages/design/src/provider.tsx` — 每次渲染生成新函数，只在把 `t` 放进依赖数组时才有影响，目前没有这样的用法。
- **`.cb-btn-link-*` 重复了按钮变体的样式且缺按下 / 禁用态；`.cb-sheet-open` 放在 `shell.css`** — `packages/design/src/styles/shell.css` — 以链接渲染的按钮（PageHeader 的 href 操作、Sheet 的「在新页打开」）复制了一份颜色规则；合理的做法是让 `.cb-btn` 的变体规则同时匹配 `[data-variant]` 与链接类名，属于样式重构，不影响当前截图。Sheet 的链接同样复制了 IconButton 的类名。
- **Tooltip 每个实例各包一个 `Provider`** — `packages/design/src/display/tooltip.tsx` — 功能正确，只是相邻 Tooltip 之间没有共享「跳过延迟」；需要在 DesignProvider 里放一个全局 Provider，涉及 provider 结构，单独做。
- **DataTable：`rowLabel` 用 `String.replace` 拼「选择 {name}」，名称里的 `$&` 等替换模式会被解释** — `packages/design/src/table/DataTable.tsx` — 现有数据（Agent 名称等）不含 `$`；改为函数式替换即可，顺手和下一条一起改。
- **DataTable：每行 `columns[0].cell(row)` 被调用两次（取行名 + 渲染）** — `packages/design/src/table/DataTable.tsx` — 只是重复计算，cell 都是纯函数，无可见影响。
- **DataTable：只有一列时焦点环的左右边被 `td:first-child` / `td:last-child` 两条规则互相覆盖** — `packages/design/src/styles/table.css` — 实际页面没有单列表格；修法是给同时是首末列的格子单独一条四边内描边规则。
- **`.cb-table-expand-body > *` 强制每个子元素 `display: flex`** — `packages/design/src/styles/table.css` — 为了在行首加 `└` 引导；传入块级内容（如多段文字）时会被横排。需要定下展开行内容的约定（每个子元素是一行），写进 DataTable 的注释或改用包装元素，和展开行 API 一起考虑。
- **Menu 项以 `label` 作 key；危险项之前若已有分隔线会出现两条分隔线** — `packages/design/src/overlays/menus.tsx` — 同一菜单内标签重复或手动加了分隔线的用法目前不存在；改为显式 `id` 会改公开类型，留到菜单 API 下一次调整。
- **PageHeader 操作以 `label` 作 key；「主操作在最右」没有强制** — `packages/design/src/shell/page-header.tsx` — 同上，标签重复的用法不存在；主操作位置由调用方保证，`assertHeader` 只检查数量。
- **`useStatusBar` 传入内联 JSX 时每次渲染都会重新设置** — `packages/design/src/shell/status-bar.tsx` — 只多一次 setState（值相同时 React 会跳过子树），目前都传字符串。
- **Body 的 `activeAnchor` 只作为初始值（非受控）** — `packages/design/src/shell/body.tsx` — FormPage 的锚点高亮由滚动驱动，外部改 `activeAnchor` 不会生效；目前没有需要外部驱动的场景，做成受控要同时处理滚动监听，单独做。
- **Rail 的折叠状态不持久化** — `packages/design/src/shell/body.tsx` — 刷新后恢复展开；持久化需要决定存 Cookie 还是用户设置（多副本下不能放进程内存），和用户偏好一起做。

## 页面（apps/web）

- **ModelParams 告警卡片混用 danger / warn 两种色调** — `apps/web/src/components/ModelParams.tsx` — spec 对「参数被模型忽略」这类提示的色调没有明确规定，需要先在 spec 里定下来再改。
- **对话页为显示 Agent 名称拉取整个 Agent 列表** — `apps/web/src/components/ChatView.tsx`（`listAgents` 后按 id 查找） — 应改为按 id 取单个 Agent 或由会话接口带回名称，涉及内核接口，留到会话页迭代。
- **首页组织选择在已为空时仍再次触发 `switchOrg(null)`** — `apps/web/src/app/[locale]/(app)/page.tsx` — 多一次无害请求；加相等判断即可，和首页改版一起做。

## 自定义检查（`pnpm check:web-ui`）

- **标识符展开（`{...props}`）里的 `className` / `style` 不分析** — `tools/checks/src/web-ui.ts` — 需要类型信息才能可靠判断，当前检查是纯语法级；评审兜底。
- **dev 豁免 fixture 除了被豁免的规则外没有其他违规** — `tools/checks/fixtures/web-ui/` — 不能证明豁免范围只限于目录页允许的那几条；补一个「豁免目录里的其他违规仍报错」的 fixture。
- **从 design 子路径导入（`@capybara-hq/design/...`）和默认导入的模板不识别** — `tools/checks/src/web-ui.ts` — 「页面必须用模板」的判断只认命名导入；目前代码都用命名导入，补识别规则与 fixture。
- **没有动态 `import("x.css")` 的 fixture** — `tools/checks/fixtures/web-ui/` — 规则已覆盖静态导入；动态导入是否被拦需要一个 fixture 证明。
- **「只调用 notFound」的页面豁免适用于任何不含 JSX 的页面** — `tools/checks/src/web-ui.ts` — 豁免条件过宽（不含 JSX 的页面也可能返回其他组件的调用结果）；应收紧为「函数体只有 notFound() 调用 / 重定向」。

## 测试缺口

- **`applyTheme` 测试不断言 Cookie 属性；tokens 测试对与主题无关的变量用子串匹配** — `packages/design/test/theme.test.ts`、`packages/design/test/tokens.test.ts` — 行为正确，只是断言偏弱。
- **`afterEach(cleanup)` 写在文件中部** — `packages/design/test/controls.test.tsx` — 对执行顺序无影响（vitest 按文件注册钩子），整理测试时挪到顶部。
- **缺 Field 帮助文字、Select 的测试** — `packages/design/test/controls.test.tsx` — 组件本身简单，目录页截图覆盖了外观。
- **缺 BarChart 方块计算、Pagination 省略号的测试** — `packages/design/test/display.test.tsx` — 截图覆盖了常见形态，边界（单页、两端省略）没有单测。
- **缺 Popover、Sheet「继续编辑」、命令面板 Esc 的测试；Toast 进度条更新测试偏薄** — `packages/design/test/overlays.test.tsx` — 都是 Radix / cmdk 提供的行为，补测试防回归。
- **DataTable 缺禁用行按空格、取消全选、density、错误态无 requestId 的测试** — `packages/design/test/table.test.tsx` — 实现已覆盖，测试补齐即可。
- **没有自定义 DesignProvider `link` 的测试（TopBar、带 href 的 Tabs、Sheet「在新页打开」）** — `packages/design/test/shell.test.tsx` — 默认 `<a>` 已覆盖；Next 的 Link 在 `apps/web` 里经页面测试间接覆盖。
- **目录页测试卫生：Toast 示例的 effect 没有依赖数组；冒烟测试只断言能渲染** — `apps/web/src/dev/catalog/overlays.tsx`、`apps/web/test/catalog.test.tsx` — 目录页仅开发用，截图回归是主要保障。
- **截图用例按私有类名定位（聚焦输入框用 `cb-field` xpath，Tooltip 用 `.cb-tooltip`）** — `apps/web/visual/catalog.spec.ts` — Radix 的 `role=tooltip` 是读屏用的隐藏副本，取不到可见框；改为给目录页元素加 `data-testid` 需要先放开 check:web-ui 对目录页的限制，暂保留。

## CI

- **`visual-update` 用 `GITHUB_TOKEN` 推送的提交不会触发 CI** — `.github/workflows/visual-update.yml` — GitHub 的限制；需要改用部署密钥或 GitHub App 令牌推送，涉及仓库密钥配置，由维护者决定。（并发组已在 `7b05665` 加上。）

## 合并前已处理

| 遗留事项 | 清理项 |
|---|---|
| 加载态 ⠿ 把按钮撑宽 | A1 |
| 收件箱 Rail 表格、链路瀑布表格仍有外框（与区域边线叠成双线） | A2 |
| `framed={false}` 嵌入卡片时行状态底色只补了一部分 | A3 |
| 全局 `[data-state=open]:is(.cb-btn, button)` 命中使用方按钮、与实心变体同优先级 | A4（并修正 Button 覆盖 Radix 传入的 `data-state`，打开 / 有值状态悬停时保持） |
| Toast 进度条 `margin-right: 32px` 魔数 | A5 |
| 没有 Tooltip、按下态截图 | A6 |
| 数值框逐键夹取 | B7 |
| `beforeunload` 未设 `returnValue` | B8 |
| DangerConfirm 未处理 onConfirm 拒绝、关闭后 `busy` 不复位、说明未 `aria-describedby` | B9 |
| Menu 带 href 的禁用项仍可跳转 | B10 |
| Pagination 页码越界不夹取；Tabs value 无匹配时整栏不可达 | B11 |
| 行无 `aria-selected` / `aria-current`；行复选框与 ⋯ 都在 Tab 顺序里 | B12 |
| `role=alert` 嵌在 aria-live 区域内 | B13 |
| 未给 empty / noResults 时空状态标题为空 | B14 |
| Textarea code 行号不随滚动 | B15 |
| `/dev/ui` 门禁的动态渲染是隐式的 | B16 |
| HeaderAction 的 href 忽略 shortcut、类型允许同时给 onSelect | B17 |
| 首列左内边距 8 而非 16 | 已在 `b32d474` 处理 |
| 设计系统 changeset | 已有 `.changeset/calm-pixels-render.md` |
