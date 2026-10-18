# 设计系统（packages/design）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 `@capybara-hq/design`（token、字体、组件、App Shell、12 个页面模板），用目录页 + 截图回归 + `pnpm check` 把规格变成可检查的约束，并把 `apps/web` 现有页面全部迁到模板上。

**Architecture:**
- **一个包承载全部视觉**：`packages/design` 输出 React 组件和一份 CSS（`tokens.css` + 组件样式，类名前缀 `cb-`，变体用 `data-*` 属性）。`apps/web` 只组合组件，自身不写任何样式（不得有 `className` / `style` / `.css`）。
- **结构由模板决定**：App Shell（TopBar、StatusBar）由 `apps/web` 的 `(app)` 布局渲染；PageHeader、PageTabs、Body、ActionRow 由页面模板渲染。页面 = 模板 + 插槽内容。
- **三道约束**：类型（props 限定结构，如最多一个 primary 操作）→ `pnpm check`（导入边界、样式归属、模板强制、颜色字面量）→ 截图回归（`/dev/ui` 目录页，在固定的 Playwright Docker 镜像中出图）。
- **无障碍底座**：Dialog / Popover / Menu / Tooltip 用 Radix Primitives，命令面板用 cmdk，只在 design 包内使用。

**Tech Stack:** React 19、Next 16（`transpilePackages`）、Radix Primitives、cmdk、Vitest + Testing Library（jsdom）、Playwright（`toHaveScreenshot`）、oxc-parser（检查）、fonttools（字体子集化脚本，仅开发者本地运行）。

**Spec:** `docs/design/spec.md`（视觉参考：设计画布 https://claude.ai/artifact/KsyGe4akVT4KbqUHfHXdXd 的 "E · 设计系统" 两行）

**参考：** M2 计划（格式与 web 骨架）`docs/superpowers/plans/2026-10-17-m2-agent-runtime.md` Task 16–17；现有检查写法 `tools/checks/src/i18n.ts` 与其测试。

## Global Constraints

- 包名 `@capybara-hq/design`；Apache-2.0；`exports` 沿用 plugin-sdk 的 `@capybara-hq/source` 条件写法，另导出 `./styles.css`。依赖装当时最新稳定版。
- `apps/web` 只从 `@capybara-hq/design` 引入 UI；不得直接依赖 `@radix-ui/*`、`cmdk`。
- `apps/web/src` 不得出现 `className` / `style` 属性、`.css` 文件、颜色字面量（`#rgb`、`#rrggbb`、`rgb(`、`hsl(`）。
- `packages/design` 中颜色字面量只允许出现在 `src/styles/tokens.css`。
- 全站唯一字体 Sarasa Mono SC（400 / 700），自托管 woff2；圆角 0；线 1px；间距 4 的倍数；控件高 24 / 28 / 36。
- token 值逐字取自 spec §2.1、§2.5，不得自行调整；深色是默认主题。
- 主色只用于 spec §2.3 的五种职责；状态必须「符号 + 颜色 + 文字」（spec §2.4）。
- design 包内的界面文案放在 `src/i18n.ts`（zh / en 两套，类型保证 key 一致）；`apps/web` 文案仍走 next-intl。
- 每个组件提供 spec §6 列出的全部状态，深浅两套；新组件必须同时加进 `/dev/ui`。
- 每道新增的自动检查必须先证明会红（fixture 测试 + 临时违规跑 `pnpm check`）。
- 截图基准只在 Docker 镜像 `mcr.microsoft.com/playwright:v<@playwright/test 版本>-noble` 中生成；本地 darwin 截图不入库。
- Conventional Commits，标题中文；提交身份 `Grant <284885069@qq.com>`。

## Review Focus

1. **超长内容**：80 字的 Agent 名、7 位数指标、全中文长标题放进 PageHeader 与表格单元格时，PageHeader 仍是 56 高单行（标题省略 + Tooltip），表格单元格单行省略。→ Task 6 单测断言省略与 `title`；Task 8 目录页 `stress` 路由截图。
2. **纯键盘操作**：Tab 顺序合理、焦点环可见；打开 Dialog / Sheet / 命令面板后焦点锁定，关闭后回到触发按钮；DataTable ↑↓ / 空格 / ↵ / Esc 可用。→ Task 4、Task 5 单测。
3. **浅色主题对比度**：正文、次要文字、主色底白字在两套主题下都 ≥ 4.5:1。→ Task 1 对比度单测直接读 `tokens.css` 计算。
4. **窄屏**：< 1280 Inspector 改为 Sheet，< 960 Rail 改为「筛选」按钮；页面不出现横向滚动条。→ Task 6 单测（`matchMedia` 桩）+ Task 8 在 1024 / 900 宽度截图。
5. **有未保存修改时离开**：关闭 Sheet 需二次确认；FormPage 在 `unsaved > 0` 时离开页面触发浏览器确认。→ Task 4、Task 7 单测。

---

## 文件结构

```
packages/design/
  package.json  tsconfig.json
  scripts/subset-font.py            # 开发者本地：Sarasa → 子集 woff2
  scripts/charset.txt               # 子集字符表（ASCII + GB2312 一级 + 符号）
  src/index.ts                      # 唯一出口
  src/i18n.ts  src/provider.tsx     # DesignProvider（locale）、文案
  src/theme.ts                      # Theme、Cookie 读写
  src/styles/{index,tokens,base,controls,display,overlays,table,shell,templates}.css
  src/fonts/{SarasaMonoSC-Regular.woff2,SarasaMonoSC-Bold.woff2,OFL.txt}
  src/layout/{Stack,Grid,Card,Text}.tsx
  src/controls/{Button,IconButton,Field,Input,Textarea,Select,Stepper,Checkbox,RadioGroup,Switch}.tsx
  src/display/{Tabs,Segmented,Pagination,Badge,Kbd,StatusMark,Metric,Tooltip,Logo,Dither,Skeleton,BarChart}.tsx
  src/overlays/{Dialog,DangerConfirm,Sheet,Popover,Menu,Toast,CommandPalette}.tsx
  src/table/{DataTable,types}.tsx
  src/shell/{AppShell,TopBar,PageHeader,PageTabs,Body,ActionRow,StatusBar,context}.tsx
  src/templates/{Overview,List,Detail,Form,Settings,Inbox,Playground,Trace,Wizard,Auth,Status,Onboarding}Page.tsx
  src/templates/names.ts            # PAGE_TEMPLATES
  test/*.test.tsx
apps/web/
  src/app/[locale]/(auth)/{login,setup}/page.tsx
  src/app/[locale]/(app)/layout.tsx  (app)/page.tsx  (app)/agents/...  (app)/chat/...
  src/app/[locale]/dev/ui/[...slug]/page.tsx  src/dev/catalog/*.tsx
  playwright.visual.config.ts  visual/catalog.spec.ts
tools/checks/src/web-ui.ts  tools/checks/test/web-ui.test.ts  tools/checks/fixtures/web-ui/*
skills/writing-web-ui/SKILL.md  docs/design/{spec.md,reference/*.png}
.github/workflows/{ci.yml,visual-update.yml}
```

---

### Task 1: 包骨架、token、字体与主题

**Files:**
- Create: `packages/design/{package.json,tsconfig.json}`、`src/{index,theme,i18n,provider}.ts(x)`、`src/styles/{index,tokens,base}.css`、`src/fonts/*`、`scripts/{subset-font.py,charset.txt}`、`test/tokens.test.ts`、`test/theme.test.ts`
- Modify: 根 `tsconfig.json`（references 加 `packages/design`）、`vitest.config.ts`（新增 project `design`：jsdom，`packages/design/test/**/*.test.{ts,tsx}`）、`apps/web/package.json`（依赖 `@capybara-hq/design: workspace:*`）、`apps/web/next.config.ts`（`transpilePackages: ["@capybara-hq/design"]`）

**Interfaces:**
- Produces:
  - `type Theme = "dark" | "light"`；`THEME_COOKIE = "cb-theme"`；`parseTheme(v: string | undefined): Theme`（非法值 → `"dark"`）；`applyTheme(t: Theme): void`（设 `document.documentElement.dataset.theme` 并写 Cookie，`max-age` 一年，`path=/`，`samesite=lax`）。
  - `TOKEN_NAMES`：spec §2.1 + §2.5 全部 token 名（`bg`、`panel`、`hover`、`line`、`line-strong`、`ink`、`muted`、`faint`、`accent`、`accent-hover`、`accent-press`、`on-accent`、`accent-tint`、`ok`、`fail`、`warn`、`scrim`、`shadow-1`、`shadow-2`、`shadow-sheet`）。
  - `tokens.css`：`:root[data-theme="dark"]` 与 `:root[data-theme="light"]` 各定义全部 `--cb-<name>`；另有主题无关变量 `--cb-font`、`--cb-z-sheet: 40`、`--cb-z-dialog: 50`、`--cb-z-popover: 60`、`--cb-z-toast: 70`、`--cb-motion: 120ms`。
  - `base.css`：`@font-face`（400 / 700，`font-display: swap`），`body` 13/20、`tabular-nums`、`bg` / `ink`，`:focus-visible` 规则（spec §2.5），`prefers-reduced-motion` 关动效。
  - `styles.css` 出口 = `src/styles/index.css`（按顺序 `@import` 全部样式文件）。
  - `DesignProvider({ locale: "zh" | "en", children })`；`useDesignT(): (key: DesignKey) => string`。
- [ ] **Step 1: 写失败测试**
  - `tokens.test.ts`：解析 `tokens.css`（按主题块正则取 `--cb-x: value;`）：
    - 两套主题的 token 集合都等于 `TOKEN_NAMES`；
    - 值逐字等于 spec §2.1（例：dark `accent` = `#FF6A13`，light `accent` = `#CC4609`，light `on-accent` = `#FFFFFF`）；
    - 对比度（WCAG 相对亮度公式）：`ink/bg`、`muted/bg`、`on-accent/accent` 在两套主题均 ≥ 4.5；`accent/bg` ≥ 3。
  - `theme.test.ts`：`parseTheme(undefined)` → `"dark"`，`parseTheme("light")` → `"light"`，`parseTheme("x")` → `"dark"`；`applyTheme("light")` 后 `document.documentElement.dataset.theme === "light"` 且 `document.cookie` 含 `cb-theme=light`。
- [ ] **Step 2: 运行确认失败** `pnpm vitest run --project design` → FAIL（模块不存在）。
- [ ] **Step 3: 实现**。字体：本地运行 `python3 scripts/subset-font.py <Sarasa 解压目录>`（用 `pyftsubset --flavor=woff2 --layout-features='*' --text-file=scripts/charset.txt`，charset 由脚本 `--build-charset` 生成：ASCII 0x20–0x7E + GB2312 一级汉字 + `apps/web/messages/*.json` 与 `src/i18n.ts` 中出现的全部字符 + `▲▼▾▴●✓✗‖▌¥·…→←↑↓↵↻↗↕─│└⋯⌘⌕☰▦⚙∅⊘○⠿✕‹›–−`），产物与 Sarasa 的 OFL.txt 一起提交；脚本头注释写明来源版本（Sarasa Gothic v1.0.42，`SarasaMonoSC-TTF-Unhinted`）。
- [ ] **Step 4: 运行确认通过**；`pnpm typecheck`、`pnpm lint` 通过。
- [ ] **Step 5: 提交** `feat(design): 设计包骨架、token、更纱等宽字体与主题`。

### Task 2: 布局原语与表单控件

**Files:**
- Create: `src/layout/*`、`src/controls/*`、`src/styles/controls.css`、`test/layout.test.tsx`、`test/controls.test.tsx`

**Interfaces:**
- Consumes: Task 1 的样式与 `useDesignT`。
- Produces（全部从 `src/index.ts` 导出；变体以 `data-variant` / `data-size` / `data-state` 暴露，CSS 只按这些属性着色）：
  - `Stack({ gap?: 0|4|8|12|16|24|32; direction?: "column"|"row"; align?; justify?; wrap?: boolean; children })`
  - `Grid({ columns: 1|2|3|4|"form"; gap?; children })`（`"form"` = `220px 1fr`）
  - `Card({ title?: ReactNode; actions?: ReactNode; tone?: "default"|"danger"; children })`
  - `Text({ variant?: "h1"|"h2"|"body"|"small"|"micro"; tone?: "ink"|"muted"|"faint"|"accent"|"ok"|"fail"|"warn"; as?: ElementType; truncate?: boolean; children })`（`truncate` 时设 `title` 为纯文本内容）
  - `Button(ButtonHTMLAttributes & { variant?: "primary"|"secondary"|"default"|"ghost"|"danger"|"danger-solid"; size?: 24|28|36; loading?: boolean; shortcut?: string })`：默认 `default` / 28；`loading` → `disabled` + `aria-busy` + 前缀 `⠿`。
  - `IconButton({ label: string; icon: ReactNode; size?: 24|28|36 } & ButtonHTMLAttributes)`：`aria-label={label}`。
  - `Field({ label: string; required?: boolean; optional?: boolean; help?: string; error?: string; count?: { value: number; max: number }; onReset?: () => void; children: ReactElement })`：给子控件注入 `id`、`aria-describedby`、`aria-invalid`、`aria-required`；错误文案前缀 `✗ `；传入 `onReset` 时标签行右侧显示「↺ 恢复默认」按钮。
  - `Slider({ value: number | undefined; min: number; max: number; step?: number; onChange(n: number): void; label: string; withInput?: boolean })`：`role="slider"`，`aria-valuenow` 在 `value === undefined` 时省略；←→ 按 `step`，PageUp/PageDown 按 10 步；`withInput` 时右侧数值框与滑块联动。
  - `Input(InputHTMLAttributes & { prefix?: ReactNode; suffix?: ReactNode; invalid?: boolean })`、`Textarea(TextareaHTMLAttributes & { code?: boolean })`（`code` 显示行号列）、`Select(SelectHTMLAttributes & { options: { value: string; label: string }[] })`（原生 select + `▾`）、`Stepper({ value: number; min?; max?; step?; onChange(n: number); label: string })`
  - `Checkbox({ checked: boolean | "indeterminate"; onChange(next: boolean); label?: ReactNode; disabled? })`、`RadioGroup({ value; onChange; options: { value; label; description? }[]; variant?: "plain"|"card"; label: string })`、`Switch({ checked; onChange; label })`（`role="switch"`）
- [ ] **Step 1: 写失败测试**
  - `Button`：`variant="primary"` 渲染 `data-variant="primary"`、`data-size="28"`；`loading` → `disabled`、`aria-busy="true"`、文本以 `⠿` 开头；`shortcut="⌘S"` 文本含 `⌘S`。
  - `IconButton` 没有可见文字但 `getByRole("button", { name: "更多" })` 可取到。
  - `Field` + `Input`：`error="名称已存在"` → 输入框 `aria-invalid="true"`，`aria-describedby` 指向文本 `✗ 名称已存在`；`required` → `aria-required="true"` 且标签含 `*`；`count={{value:18,max:200}}` 显示 `18 / 200`。
  - `Checkbox` `checked="indeterminate"` → `aria-checked="mixed"`；点击调用 `onChange(true)`。
  - `RadioGroup variant="card"` 方向键切换选中项。
  - `Switch` 空格切换并回调。
  - `Slider min=0 max=1 step=0.1 value=0.3`：`aria-valuenow="0.3"`；按 → 调用 `onChange(0.4)`；`value={undefined}` 时无 `aria-valuenow`；`withInput` 时数值框输入 `0.7` 调用 `onChange(0.7)`。
  - `Field onReset`：显示「↺ 恢复默认」，点击调用 `onReset` 一次；不传时不显示。
  - `Text truncate` 的元素 `title` 等于其文本。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（样式值取 spec §6.1–§6.3）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(design): 布局原语与表单控件`。

### Task 3: 导航与展示组件

**Files:**
- Create: `src/display/*`、`src/styles/display.css`、`test/display.test.tsx`

**Interfaces:**
- Produces:
  - `Tabs({ items: { id: string; label: string; count?: number|string; disabled?: boolean; href?: string }[]; value: string; onChange?(id: string); label: string })`：有 `href` 时渲染链接（`aria-current="page"`），否则 `role="tablist"`。
  - `Segmented({ options: { value: string; label: string }[]; value: string; onChange(v: string); label: string })`
  - `Pagination({ page: number; pageSize: number; total: number; pageSizes?: number[]; onPage(p: number); onPageSize?(s: number) })`：范围文本 `1–50 / 1,284`（千分位），首页禁用「上一页」，末页禁用「下一页」。
  - `Badge({ tone?: "default"|"accent"|"count"; children })`、`Kbd({ children })`
  - `StatusMark({ status: "running"|"success"|"failed"|"waiting"|"queued"|"cancelled"; label?: string })`：符号与颜色按 spec §2.4，默认文案取 `useDesignT`。
  - `Metric({ label: string; value: ReactNode; delta?: { value: string; direction: "up"|"down" } })`
  - `Tooltip({ content: ReactNode; children: ReactElement })`（Radix，延迟 400ms）
  - `Logo({ scale?: 2|3|6; tone?: "accent"|"muted"; wordmark?: boolean })`；`CAPYBARA_BITMAP: readonly string[]`（spec §3 位图原样）
  - `Dither({ side: "left"|"right"; seed?: number })`（4px 方块，确定性伪随机，可点缀 ≤1% 主色）
  - `Skeleton({ rows: number })`、`BarChart({ series: { value: number; fail?: number }[]; current?: number; label: string })`（离散方块，spec §6.8）
- [ ] **Step 1: 写失败测试**：`StatusMark status="failed"` 文本为 `✗ 失败`（zh）/ `✗ Failed`（en）；`Pagination` `page=1,pageSize=50,total=1284` 显示 `1–50 / 1,284`，「上一页」禁用，点「下一页」调用 `onPage(2)`；`Tabs` 带 `href` 时当前项 `aria-current="page"`；`Logo` 的 `<path>` 方块数等于位图中 `X` 的个数（106）；`BarChart` 渲染 `role="img"` 且 `aria-label` 为传入值。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: 提交** `feat(design): 标签、分页、状态、指标、Logo 等展示组件`。

### Task 4: 浮层

**Files:**
- Create: `src/overlays/*`、`src/styles/overlays.css`、`test/overlays.test.tsx`
- Modify: `packages/design/package.json`（依赖 `@radix-ui/react-dialog`、`@radix-ui/react-popover`、`@radix-ui/react-dropdown-menu`、`@radix-ui/react-tooltip`、`cmdk`）

**Interfaces:**
- Produces:
  - `type MenuItem = { label: string; shortcut?: string; onSelect(): void; danger?: boolean; disabled?: boolean } | "separator"`
  - `Dialog({ open; onOpenChange(o: boolean); title: string; size?: 480|640; footer: ReactNode; initialFocus?: "primary"|"cancel"; children })`
  - `DangerConfirm({ open; onOpenChange; title: string; description: ReactNode; confirmName: string; confirmLabel: string; onConfirm(): void | Promise<void> })`：输入与 `confirmName` 完全一致前确认按钮 `disabled`；一致后为 `danger-solid`；默认焦点在取消。
  - `Sheet({ open; onOpenChange; title: string; meta?: ReactNode; width?: 480|720; openHref?: string; tabs?: ReactNode; footer?: ReactNode; dirty?: boolean; children })`：`dirty` 时关闭先弹出确认 Dialog（文案「放弃未保存的修改？」）。
  - `Popover({ trigger: ReactElement; active?: boolean; children })`、`Menu({ trigger: ReactElement; items: MenuItem[] })`（危险项自动排到最后并前置分隔线）
  - `ToastProvider({ children })`；`useToast(): { success(msg: string): void; error(msg: string, opts?: { actionLabel: string; onAction(): void }): void; progress(msg: string, p: { done: number; total: number }): { update(done: number): void; close(): void } }`：success 4000ms 自动关闭，error 不自动关闭。
  - `CommandPalette({ open; onOpenChange; groups: { label: string; items: { id: string; label: string; shortcut?: string; onSelect(): void }[] }[] })`
- [ ] **Step 1: 写失败测试**
  - `Dialog`：打开后焦点在主操作（`initialFocus="primary"`）；Tab 不离开对话框；Esc 关闭后焦点回到触发按钮。
  - `DangerConfirm`：输入 `support-tri` 时确认按钮 `disabled`，输入 `support-triage` 后可用且 `data-variant="danger-solid"`，点击调用 `onConfirm` 一次。
  - `Sheet dirty`：点关闭不调用 `onOpenChange(false)`，出现「放弃未保存的修改？」；确认后才调用。
  - `Menu`：`danger` 项排在最后且其前有 `role="separator"`。
  - `useToast().success` 4000ms 后消失（fake timers）；`error` 10000ms 后仍在。
  - `CommandPalette`：输入 `sup` 过滤出含 `sup` 的项；↵ 调用该项 `onSelect`。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: 提交** `feat(design): 对话框、Sheet、菜单、Toast 与命令面板`。

### Task 5: DataTable

**Files:**
- Create: `src/table/{DataTable,types}.tsx`、`src/styles/table.css`、`test/table.test.tsx`

**Interfaces:**
- Consumes: Task 2 `Checkbox`、`Button`；Task 3 `Pagination`、`Skeleton`、`Logo`、`Tooltip`；Task 4 `Menu`、`MenuItem`。
- Produces:
  - `type Column<T> = { key: string; header: string; cell(row: T): ReactNode; align?: "left"|"right"; tone?: "ink"|"muted"; sortable?: boolean; width?: number }`
  - `DataTable<T>({ columns: Column<T>[]; rows: T[]; rowKey(row: T): string; label: string; state?: "ready"|"loading"|"error"; error?: { code: string; requestId?: string; onRetry(): void }; empty?: { title: string; hint?: string; action?: ReactNode }; noResults?: { description: string; onClear(): void }; toolbar?: ReactNode; selection?: { selected: ReadonlySet<string>; onChange(next: Set<string>): void }; bulkActions?(selected: ReadonlySet<string>): ReactNode; activeKey?: string; onOpen?(row: T): void; rowMenu?(row: T): MenuItem[]; expand?(row: T): ReactNode | null; isDisabled?(row: T): boolean; sort?: { key: string; dir: "asc"|"desc"; onChange(key: string, dir: "asc"|"desc"): void }; pagination?: PaginationProps; density?: "default"|"compact"|"media" })`
  - 行属性：`data-state` 取 `active` / `checked` / `disabled`（同一行可组合，用空格分隔）；空状态区 `data-empty` 取 `loading` / `empty` / `no-results` / `error`。
- [ ] **Step 1: 写失败测试**
  - 勾选 1 行 → 工具栏位置变为批量栏，显示「已选 1 项」与 `bulkActions` 内容；Esc → `selection.onChange(new Set())`。
  - 表头全选框：部分勾选时 `aria-checked="mixed"`；`isDisabled` 的行不可勾选、全选不包含它。
  - `activeKey` 行 `data-state` 含 `active`；`onOpen` 在点击行与焦点行按 ↵ 时调用。
  - 键盘：焦点在第 1 行按 ↓ 到第 2 行，空格切换勾选。
  - `state="loading"` 渲染骨架；`rows=[]` + `empty` → 显示 `empty.title` 与 action；`rows=[]` + `noResults` → 「清除筛选」调用 `onClear`；`state="error"` → 显示 `✗` 与 `code`，「重试」调用 `onRetry`。
  - `sort`：点击可排序表头调用 `onChange(key, "asc")`；当前排序列表头显示 `▼` / `▲` 且 `aria-sort` 正确。
  - `align: "right"` 的单元格 `data-align="right"`。
  - 超长单元格内容带 `title`（Review Focus 1）。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: 提交** `feat(design): DataTable（选择、批量、排序、展开、空状态、键盘）`。

### Task 6: App Shell

**Files:**
- Create: `src/shell/*`、`src/styles/shell.css`、`test/shell.test.tsx`

**Interfaces:**
- Consumes: Task 2–4 组件。
- Produces:
  - `AppShell({ topBar: TopBarProps; status: { context: string; version: string; system?: ReactNode }; children })`：纵向 flex，TopBar 40 → 子内容（模板）→ StatusBar 24；全局 ⌘K 打开 `CommandPalette`。
  - `TopBarProps = { nav: { id: string; label: string; href: string }[]; activeNav: string; org: { name: string; menu?: MenuItem[] } | null; user: { name: string; menu: MenuItem[] }; commands: CommandGroup[] }`
  - `useStatusBar(pageStatus: ReactNode): void`：页面把「页面状态」写入 StatusBar（卸载时清除）。
  - `PageHeaderProps = { parent?: { label: string; href: string }; title: string; count?: ReactNode; status?: ReactNode; metrics?: MetricProps[]; actions?: HeaderAction[] }`；`HeaderAction = { label: string; variant: "primary"|"secondary"|"default"; onSelect?(): void; href?: string; shortcut?: string } | { menu: MenuItem[]; label: string }`。
  - 校验函数 `assertHeader(p: PageHeaderProps): void`：`metrics.length > 5` 或 primary 操作多于 1 个时抛 `Error`（开发与测试环境；生产只 `console.error`）。
  - `PageHeader(p)`（高 56，单行，标题 `truncate`）、`PageTabs(TabsProps)`、`Body({ layout: "single"|"rail"|"inspector"|"rail-inspector"|"centered"; rail?: ReactNode; inspector?: ReactNode; inspectorTitle?: string; anchors?: { id: string; label: string; error?: boolean }[]; children })`、`ActionRow({ unsaved?: number; errors?: number; cancel?: { label: string; onSelect(): void }; secondary?: ButtonSpec; primary: ButtonSpec })`，`ButtonSpec = { label: string; onSelect(): void; shortcut?: string; loading?: boolean; disabled?: boolean }`。
  - 响应式：`Body` 用 `matchMedia("(max-width: 1279px)")` 把 inspector 改为 `Sheet`（工具按钮「详情」打开），`(max-width: 959px)` 把 rail 改为「筛选」按钮 + `Sheet`。
- [ ] **Step 1: 写失败测试**
  - `AppShell`：顺序为 TopBar、内容、StatusBar；`useStatusBar("已筛选 18 / 24")` 后 StatusBar 含该文本，卸载后消失；按 `⌘K`（`metaKey`）打开命令面板。
  - `PageHeader`：带 `parent` 时渲染链接 `Agents /` 与标题；两个 primary → `assertHeader` 抛错；6 个 metrics → 抛错；80 字标题的元素带 `title`。
  - `ActionRow`：`unsaved=2, errors=1` 显示 `‖ 2 处未保存` 与 `· 1 处错误`；primary 按钮在 DOM 中位于最后。
  - `Body layout="rail-inspector"`：`matchMedia` 桩返回 1279 匹配时 inspector 不直接渲染、出现「详情」按钮，点击打开 Sheet；959 匹配时 rail 改为「筛选」按钮。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: 提交** `feat(design): App Shell（TopBar、PageHeader、Body、ActionRow、StatusBar）`。

### Task 7: 页面模板

**Files:**
- Create: `src/templates/*`、`src/styles/templates.css`、`test/templates.test.tsx`

**Interfaces:**
- Consumes: Task 6 的 `PageHeaderProps`、`Body`、`ActionRow`、`PageTabs`。
- Produces（名称与 spec §5 一一对应；`PAGE_TEMPLATES` 为这 12 个组件名的只读数组）：
  - `OverviewPage({ header; children })` — single
  - `ListPage({ header; rail?; actionRow?; children })` — rail（无 rail 时 single）
  - `DetailPage({ header; tabs: TabsProps; inspector?; children })` — inspector
  - `FormPage({ header; anchors; actionRow: ActionRowProps; children })` — centered；`FormSection({ id; title; description?; children })` 渲染 `Grid columns="form"`；`actionRow.unsaved > 0` 时注册 `beforeunload`。
  - `SettingsPage({ header; nav: { id; label; href }[]; activeNav; actionRow?; children })`
  - `InboxPage({ header; list; inspector?; actionRow?; children })`
  - `PlaygroundPage({ header; composer: ReactNode; inspector; children })`
  - `TracePage({ header; waterfall: ReactNode; detail: ReactNode })`
  - `WizardPage({ header; steps: string[]; current: number; actionRow; children })`
  - `AuthPage({ title: string; subtitle?: string; footer?: ReactNode; children })`：无 Shell，居中卡片宽 400 + 两侧 `Dither` + `Logo scale={6}`。
  - `StatusPage({ header; kind: "404"|"403"|"maintenance"|"disabled"; title; description; action?: ReactNode })`
  - `OnboardingPage({ header; steps: { label; description; done: boolean; action?: ReactNode }[] })`
- [ ] **Step 1: 写失败测试**：每个模板渲染后存在 `data-template="<名称>"` 根节点，且 PageHeader 标题可见（AuthPage 除外）；`FormPage` 在 `unsaved=1` 时 `window` 上注册了 `beforeunload`，`unsaved=0` 时没有；`WizardPage current=1` 时第 1、2 步 `data-state="done|current"`；`PAGE_TEMPLATES` 长度 12 且与导出的组件名一致。
- [ ] **Step 2–4: 失败 → 实现 → 通过**。
- [ ] **Step 5: 提交** `feat(design): 12 个页面模板`。

### Task 8: `/dev/ui` 目录页与截图回归

**Files:**
- Create: `apps/web/src/app/[locale]/dev/ui/[[...slug]]/page.tsx`、`apps/web/src/dev/catalog/{index,routes,fixtures}.tsx` 与每个分区的组件文件、`apps/web/playwright.visual.config.ts`、`apps/web/visual/catalog.spec.ts`、`.github/workflows/visual-update.yml`
- Modify: `apps/web/package.json`（脚本 `visual`、`visual:update`）、`.github/workflows/ci.yml`（job `visual`）、`.gitignore`（`apps/web/visual/**/*-darwin.png`、`*-win32.png`）

**Interfaces:**
- Consumes: Task 1–7 全部导出。
- Produces:
  - 路由（`CATALOG_ROUTES` 常量）：`components`、`table`、`overlays/dialog`、`overlays/danger`、`overlays/sheet`、`overlays/menu`、`overlays/command`、`overlays/toast`、`templates/<12 个模板的 kebab 名>`、`stress`。生产环境（`NODE_ENV=production` 且 `CAPYBARA_DEV_UI !== "1"`）→ `notFound()`。
  - 目录页内容即画布稿内容：组件页覆盖 spec §6 每个组件的每个状态；`templates/list`、`templates/detail`、`templates/form` 使用画布中的示例数据（`fixtures.tsx`，Agents / support-triage / 新建 Agent）；`stress` 页放超长标题、7 位数指标、生僻字。
  - `playwright.visual.config.ts`：`testDir: "./visual"`，`webServer` 运行 `next build && next start -p 3100`（env `CAPYBARA_DEV_UI=1`），`use.baseURL = http://localhost:3100`，`expect.toHaveScreenshot = { maxDiffPixelRatio: 0, animations: "disabled" }`。
  - `catalog.spec.ts`：遍历 `CATALOG_ROUTES × ["dark","light"]`（设置 Cookie `cb-theme`），视口 1440×900，`fullPage: true`；`templates/list`、`templates/detail` 额外在 1024 与 900 宽各截一张（Review Focus 4）。
  - CI job `visual`：`container: mcr.microsoft.com/playwright:v<版本>-noble`，运行 `pnpm --filter @capybara-hq/web visual`，失败时上传 `playwright-report`（含差异图）。
  - `visual-update.yml`：`workflow_dispatch`（输入 `branch`），在同一镜像里跑 `visual:update` 并把新截图以提交 `test(web): 更新截图基准` 推回该分支。
- [ ] **Step 1: 写失败测试**：`catalog.spec.ts` 在没有基准时运行失败（预期：缺少 snapshot）。另加 jsdom 单测 `apps/web/test/catalog.test.tsx`：每个 `CATALOG_ROUTES` 都能渲染且不抛错；`NODE_ENV=production` 时页面调用 `notFound`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**目录页与配置。
- [ ] **Step 4: 本地生成 darwin 截图**（`pnpm --filter @capybara-hq/web visual --update-snapshots`，不入库）用于 Task 11 的对照验收；jsdom 单测通过。Linux 基准此时**不**生成，等 Task 11 验收通过后再生成。
- [ ] **Step 5: 提交** `feat(web): /dev/ui 设计目录页与截图回归配置`。

### Task 9: 界面规范检查（`check:web-ui`）

**Files:**
- Create: `tools/checks/src/web-ui.ts`、`tools/checks/src/cli/web-ui.ts`、`tools/checks/test/web-ui.test.ts`、`tools/checks/fixtures/web-ui/{clean,bad-import,class-name,inline-style,css-file,color-literal,page-without-template,design-color}/…`
- Modify: `tools/checks/src/cli/all.ts`（加入「界面规范」）、根 `package.json`（脚本 `check:web-ui`）、`tools/checks/package.json`（devDependency `@capybara-hq/design`）

**Interfaces:**
- Consumes: `listSourceFiles`、`ParsedFile`（`tools/checks/src/source.ts`）；Task 7 `PAGE_TEMPLATES`（只在测试中用来核对常量）。
- Produces: `checkWebUi(webSrcDir: string, designSrcDir: string): Finding[]`，规则：
  - `web-ui-import`：`apps/web/src` 非测试文件导入 `@radix-ui/*` 或 `cmdk`，或导入除 `@capybara-hq/design/styles.css` 以外的 `.css`。
  - `web-ui-class-name` / `web-ui-style`：JSX 属性 `className` / `style`。
  - `web-ui-css-file`：`apps/web/src` 下存在 `.css` 文件。
  - `web-ui-color`：字符串或模板字面量匹配 `/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i`。
  - `web-ui-template`：`src/app/**/page.tsx` 中没有任何 JSX 元素名属于 `WEB_UI_TEMPLATES`（与 `PAGE_TEMPLATES` 相同的 12 个名字）。
  - `design-color-literal`：`packages/design/src` 中除 `styles/tokens.css` 外的 `.css` / `.ts(x)` 出现颜色字面量。
  - 每条 message 写明修正方法（例：「改用 @capybara-hq/design 的组件或布局原语，页面内不写样式」）。
- [ ] **Step 1: 写失败测试**：每个违规 fixture 恰好产生 1 条对应规则的 finding，行号正确；`clean` → 0 条；`WEB_UI_TEMPLATES` 等于 `PAGE_TEMPLATES`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；CLI 先不加入 `all.ts`（现有页面尚未迁移，Task 10 完成后加入）。
- [ ] **Step 4: 运行确认通过**；`pnpm check:web-ui` 对当前 `apps/web` 报出现有页面的违规（记录数量，作为 Task 10 的待办清单）。
- [ ] **Step 5: 提交** `feat(checks): 界面规范检查（导入边界、样式归属、模板、颜色字面量）`。

### Task 10: 迁移 `apps/web` 现有页面

**Files:**
- Create: `apps/web/src/app/[locale]/(app)/layout.tsx`、`(app)/not-found.tsx`、`apps/web/src/components/shell/{AppFrame,nav}.tsx`
- Move: `[locale]/page.tsx` → `(app)/page.tsx`；`agents/**`、`chat/**` → `(app)/…`；`login`、`setup` → `(auth)/…`
- Modify: `[locale]/layout.tsx`（`<html data-theme={parseTheme(cookie)}>`、导入 `@capybara-hq/design/styles.css`、包 `DesignProvider` 与 `ToastProvider`）、`components/{login-form,setup-form,AgentList,AgentForm,ModelParams,ChatView,MessageList,Composer,OrgGate,locale-switcher}.tsx`、`messages/{zh,en}.json`、`test/*.test.tsx`、`tools/checks/src/cli/all.ts`
- Delete: `src/app/[locale]/globals.css`

**Interfaces:**
- Consumes: Task 1–7 全部；Task 9 `checkWebUi`。
- Produces（页面 → 模板映射）：
  - `(auth)/login`、`(auth)/setup` → `AuthPage`；表单用 `Field` / `Input` / `Button variant="primary" size={36}`。
  - `(app)/layout.tsx` → `AppShell`：一级导航只列已存在的路由（概览 `/`、Agents `/agents`）；组织菜单为成员组织列表（切换调用 `setCurrentOrg`）；用户菜单含语言切换、主题切换（`applyTheme`）、退出登录；StatusBar `context` = `> {账号}@{组织}:{路由}`，`version` 取 `@capybara-hq/web` 的 package 版本。
  - `(app)/page.tsx` → `OverviewPage`（问候 + 当前组织 + 去 Agents 的入口；无组织时显示 `StatusPage kind="disabled"` 文案「还没有加入任何组织」）。
  - `(app)/agents` → `ListPage` + `DataTable`（列：名称、模型；行菜单「开始对话」；header 主操作「新建 Agent」；空状态带「新建 Agent」）。
  - `ModelParams` 改用 design 控件：effort / thinking → `Segmented`；temperature → `Slider withInput`；`maxOutputTokens` → `Input type="number"`；厂商参数：枚举 → `Select`，布尔 → `Switch`，上下限齐全的数字 → `Slider`，其余 → `Input`；「恢复默认」→ `Field onReset`；错误 → `Field error`。现有 `agent-form.test.tsx` 中参数相关断言保持通过。
  - `MessageList` 的思考区（`capabilities.reasoning` 控制显隐）改为 design 的折叠区块（`Card` + `small muted` 文本），不改变显隐逻辑。
  - `(app)/agents/new` → `FormPage`，分组「基本信息」「模型」「模型参数」；`ActionRow` 取消 / 保存；保存后的 `warnings` 用 `useToast().error` 之外的 `Card tone="danger"` 列在表单顶部。
  - `(app)/chat/[conversationId]` → `PlaygroundPage`：消息列表为 children，`Composer` 为 composer，inspector 显示 agent、会话 ID、运行状态（`StatusMark`）与「停止」按钮。
  - `(app)/not-found.tsx` → `StatusPage kind="404"`。
- [ ] **Step 1: 改测试为新结构**（先红）：`login.test.tsx`、`agent-form.test.tsx`、`chat.test.tsx` 按角色与标签查询（不依赖类名）；新增断言：agents 页存在 `data-template="ListPage"`，chat 页存在 `data-template="PlaygroundPage"`，表单页 ActionRow 中「保存」为 primary。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 迁移实现**；把 `checkWebUi` 加入 `all.ts`（「界面规范」）。
- [ ] **Step 4: 验证**：`pnpm test`、`pnpm check`（含界面规范 0 条）、`pnpm typecheck`、`pnpm lint`、`pnpm --filter @capybara-hq/web build`、`pnpm --filter @capybara-hq/web e2e` 全部通过；**证明检查会红**：在 `(app)/page.tsx` 临时加 `style={{}}` → `pnpm check` 失败并点名该行，恢复后通过。手工在浏览器中走一遍登录 → 列表 → 新建 → 聊天（深浅主题各一次）。
- [ ] **Step 5: 提交** `refactor(web): 页面迁移到设计系统模板`。

### Task 11: 规格入库、技能、验收与锁定基准

**Files:**
- Create: `docs/design/spec.md`（本计划的 spec）、`docs/design/reference/*.png`（画布导出：系统布局、模板总览、列表、详情、表单、组件、表格、浮层，深浅各一）、`skills/writing-web-ui/SKILL.md`、`.changeset/<随机名>.md`
- Modify: `AGENTS.md`（目录地图加 `packages/design`；依赖链加 `apps/web -> @capybara-hq/design`；规则速记加「界面：页面 = 模板 + design 组件，不写样式，详见 skills/writing-web-ui」）

**Interfaces:**
- Produces:
  - `skills/writing-web-ui/SKILL.md`：何时用哪个模板（spec §5 表）、页面骨架示例（ListPage + DataTable）、禁止事项（与 `check:web-ui` 规则一一对应）、新组件 / 新模板的变更流程（spec §10）、如何跑 `/dev/ui` 与截图测试、如何触发 `visual-update`。
  - 验收对照页（Artifact，非仓库文件）：每个目录页路由一行，左为画布基准图、右为 Task 8 本地截图，深浅各一。
- [ ] **Step 1: 写技能与文档**；`AGENTS.md` 更新。
- [ ] **Step 2: 生成对照页交产品验收**；按反馈修改组件直到逐张确认。
- [ ] **Step 3: 锁定基准**：在 PR 分支触发 `visual-update` 工作流生成 Linux 基准；确认 CI `visual` job 通过。
- [ ] **Step 4: 证明截图回归会红**：临时把 `--cb-line` 深色值改为 `#2A2A28` → CI / 本地 Docker 中 `visual` 失败并给出差异图，恢复后通过。
- [ ] **Step 5: 提交** `docs: 设计系统规格、界面技能与 AGENTS 规则`；附 changeset。

---

## 自查记录

- spec 覆盖：§2 token → T1；§3 品牌 → T3；§4 Shell → T6；§5 模板 → T7（页面落地 T10）；§6.1–6.3 → T2；§6.4–6.5、6.8 → T3；§6.6 → T5；§6.7 → T4；§7 文案 → T1（design i18n）与 T10；§8 可访问性 → T2、T4、T5 测试；§9 → T8、T9、T11；§10 → T11 技能。
- 类型一致：`MenuItem`（T4）被 T5 `rowMenu`、T6 `TopBarProps` 使用；`PageHeaderProps` / `ActionRowProps`（T6）被 T7 使用；`PAGE_TEMPLATES`（T7）与 `WEB_UI_TEMPLATES`（T9）由测试保证一致。
