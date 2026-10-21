---
name: writing-web-ui
description: 在 apps/web 或 packages/design 下新增或修改界面时使用：页面 = 页面模板 + design 组件，哪个页面用哪个模板、ListPage + DataTable 与 FormPage + FormSection + ActionRow 的骨架、check:web-ui 禁止事项（className / style / .css / 颜色字面量 / 底层 UI 包）、新增组件或模板的变更流程，以及 /dev/ui 与截图测试（visual-update）的用法。
---

# 写界面

规范：`docs/design/spec.md`（唯一规范）。实现：`packages/design`（`@capybara-hq/design`），`apps/web` 只消费它。
视觉真值是 `/dev/ui` 目录页与入库的截图基准（`apps/web/visual/`）；`docs/design/reference/`（画布导出）目前没有，不要找。

## 核心规则

**页面 = 模板 + design 组件。** `apps/web` 不写样式：没有 `className`、`style`、`.css`、颜色字面量；排版用 `Stack` / `Grid` / `Card` / `Text`，颜色只来自 design 的 token。缺组件时先去 design 包补（见下文「新增组件或模板」），不要在页面里临时造。

## 选模板（spec §5）

| 页面 | 模板 | 要点 |
|---|---|---|
| 组织首页、Agent 概要 | `OverviewPage` | Single |
| Agents / 知识库 / 插件 / 成员列表 | `ListPage` | Rail（可选分面筛选）+ 一个 `DataTable` |
| Agent / 知识库 / 插件详情 | `DetailPage` | Content + Inspector，带 PageTabs |
| 新建 / 编辑对象 | `FormPage` | Centered，`FormSection` 分组，始终有 ActionRow |
| 组织 / 环境 / 安全设置 | `SettingsPage` | 二级导航 + Centered，有改动时 ActionRow |
| 人工审批、告警处理 | `InboxPage` | Rail + Content (+ Inspector) |
| 对话试运行 Agent | `PlaygroundPage` | Content + Inspector（实时链路） |
| 单次运行详情 | `TracePage` | Span 瀑布 + 详情 |
| 首次接入模型 / 连接器 / 插件 | `WizardPage` | Centered + 步骤条，上一步 / 下一步 |
| 登录、初始化、接受邀请 | `AuthPage` | 无 Shell |
| 404 / 403 / 维护中 | `StatusPage` | Single 居中 |
| 新组织、空环境 | `OnboardingPage` | Single 居中清单 |

提交操作放 ActionRow（`FormPage`、`WizardPage` 等自带），**不得**放 PageHeader；视图内至多一个 `variant: "primary"`，指标 ≤5（`PageHeader` 在开发与测试里会抛错）。

## 骨架示例

列表（`apps/web/src/app/[locale]/(app)/agents/page.tsx` 是真实例子）：

```tsx
"use client";

import { type Column, DataTable, ListPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";

export default function AgentsPage() {
  const t = useTranslations("agents");
  const columns: Column<Agent>[] = [
    { key: "name", header: t("columns.name"), cell: (a) => a.name },
    { key: "model", header: t("columns.model"), tone: "muted", cell: (a) => a.model },
  ];
  return (
    <ListPage
      header={{
        title: t("title"),
        count: String(agents.length),
        actions: [{ label: t("new"), variant: "primary", href: "/agents/new" }],
      }}
    >
      <DataTable
        label={t("title")}
        columns={columns}
        rows={agents}
        rowKey={(a) => a.id}
        state={loading ? "loading" : "ready"}
        empty={{ title: t("empty") }}
        rowMenu={(a) => [{ label: t("startChat"), onSelect: () => start(a.id) }]}
      />
    </ListPage>
  );
}
```

表单（真实例子：`agents/new/page.tsx`、`components/AgentForm.tsx`）：

```tsx
import { Field, FormPage, FormSection, Input, Select } from "@capybara-hq/design";

<FormPage
  header={{ parent: { label: t("agents.title"), href: "/agents" }, title: t("agents.form.title") }}
  anchors={[{ id: "basic", label: t("agents.form.basic"), error: nameError }]}
  actionRow={{
    unsaved: dirtyCount,
    errors: errorCount,
    cancel: { label: t("common.cancel"), onSelect: back },
    primary: { label: t("agents.form.submit"), onSelect: submit, loading: pending, disabled: !canSubmit },
  }}
>
  <FormSection id="basic" title={t("agents.form.basic")} description={t("agents.form.basicHint")}>
    <Field label={t("agents.form.nameLabel")} required error={nameError}>
      <Input value={name} onChange={(e) => setName(e.target.value)} />
    </Field>
  </FormSection>
</FormPage>
```

`ActionRowProps`：`{ unsaved?, errors?, cancel?, secondary?, primary }`，按钮规格 `{ label, onSelect, shortcut?, loading?, disabled? }`。示例中控件的具体 props 以 `packages/design/src/controls` 与 `/dev/ui` 为准（`Field` 会把标签、帮助、错误的 aria 关联传给子控件）。页面状态文案用 `useStatusBar(...)`；toast 用 `useToast()`；站内链接走 `DesignProvider` 的 `link`（apps/web 已传入 next-intl 的 `Link`）。

文案走 next-intl（`apps/web/messages/{zh,en}.json`）；design 内部文案走 design 自己的 i18n。

## 禁止事项（与 `pnpm check:web-ui` 规则一一对应）

规则实现：`tools/checks/src/web-ui.ts`；每条都有违规 fixture 测试。

| 规则 id | 禁止 | 改成 |
|---|---|---|
| `web-ui-import` | 导入黑名单包：`@radix-ui/*`、`cmdk`、`@emotion/*`、`@stitches/*`、`@vanilla-extract/*`、`@mui/*`、`@chakra-ui/*`、`@mantine/*`、`@headlessui/*`、`styled-components`、`antd`、`tailwindcss`、`tailwind-merge`、`clsx`、`classnames`、`class-variance-authority`、`styled-jsx`、`lucide-react`、`react-icons`；导入除 `@capybara-hq/design/styles.css` 之外的 `.css` | 用 design 导出的组件；缺就先在 design 包里补 |
| `web-ui-class-name` | `className` / `class` 属性（含 `{...{ className }}` 展开、`createElement` / `jsx` 的 props 对象） | 用 design 组件或 `Stack` / `Grid` / `Card` / `Text` |
| `web-ui-style` | `style` / `dangerouslySetInnerHTML` 属性、`<style>` 元素（同样包括展开与 `createElement`） | 同上；需要新样式时加到 design 包 |
| `web-ui-iframe` | `<iframe>` 元素、`createElement("iframe")` | 用 `EmbedFrame`（sandbox 固定 `allow-scripts allow-forms`，只转发本 iframe 的 `message`） |
| `web-ui-color` | 任何颜色写法：`#hex`、`rgb()` / `rgba()`、`hsl()` / `hsla()`、`hwb()`、`lab()` / `lch()` / `oklab()` / `oklch()`、`color()`、`color-mix()` | 颜色只来自 design token |
| `web-ui-css-file` | `apps/web/src` 下出现 `.css` 文件 | 样式写进 `packages/design` |
| `web-ui-template` | `src/app/**/page.tsx` 没有渲染「从 `@capybara-hq/design` 导入」的 12 个模板之一 | 选 §5 的模板作为骨架 |
| `design-color-literal` | `packages/design/src` 里除 `styles/tokens.css` 外出现 `#hex` / `rgb()` / `hsl()`（CSS 与 TS 字符串都查；`color-mix()` 引用 token 是允许的） | 在 `tokens.css` 定义 token，用 `var(--cb-…)` |

`web-ui-template` 的两处豁免：`app/[locale]/dev/**`（开发用目录页，其余规则照常检查）；以及只负责 404 的 page —— 不含任何 JSX、调用从 `next/navigation` 导入的 `notFound()`（如 `(app)/[...rest]/page.tsx`），页面由同段 `not-found.tsx` 的 `StatusPage` 渲染。不要借这个豁免写别的页面。

`web-ui-iframe` 是静态检查，只认得字面量：`<iframe>` 与 `createElement("iframe")`。动态标签（`const Tag = "iframe"; <Tag />`、`createElement(tag)`、`document.createElement` 拼出的名字）它看不出来，但规则照样适用——不要这样绕过，评审时按违规处理。

测试文件（`*.test.*`）不受检查。包导入规则是黑名单：引入新的样式 / UI 类依赖时，要把它加进 `FORBIDDEN_PKG`。

## 新增组件或模板

按顺序，不要跳步（spec §10）：

1. **改规格**：`docs/design/spec.md`（组件改 §6，模板改 §5，token 改 §2），评审确认；有画布则同步画布。
2. **实现**：`packages/design/src/…`，从 `src/index.ts`（或对应子目录的 `index.ts`）导出；样式写在 `src/styles/*.css`，颜色用 token；补测试（`packages/design/test/`，jsdom），覆盖状态、键盘、aria。新模板还要加进 `src/templates/names.ts` 的 `PAGE_TEMPLATES` 与 `tools/checks/src/web-ui.ts` 的 `WEB_UI_TEMPLATES`（测试保证两者一致）。
3. **目录页**：在 `apps/web/src/dev/catalog` 里加该组件的全部状态 / 该模板的整页（固定假数据，深浅两套）。
4. **更新截图基准**：入库基准只含 Linux 版，必须在 PR 分支上触发 GitHub Actions 的 `visual-update` 工作流（`workflow_dispatch`，`branch` 输入填分支名），它在固定的 Playwright Docker 镜像里生成并提交；PR 附差异图，经确认后合入。本地 darwin 截图（`*-darwin.png`）被 gitignore，只用于本地对照，不要提交。

## 怎么跑

```bash
pnpm vitest run --project design          # design 包的组件测试
pnpm check:web-ui                         # 界面规范检查（pnpm check 已包含）
pnpm --filter @capybara-hq/web dev        # 开发；/zh/dev/ui 是组件目录页
CAPYBARA_DEV_UI=1 pnpm --filter @capybara-hq/web start   # 生产构建下启用 /dev/ui（默认关闭）
pnpm --filter @capybara-hq/web visual     # 截图回归（自行 next build + start；本地 darwin 与基准不同，仅供对照）
pnpm --filter @capybara-hq/web e2e        # 真实栈 e2e（Testcontainers，需 Docker）
```

改 `apps/web` 前先读 `node_modules/next/dist/docs`（见 `apps/web/AGENTS.md`，Next 16 有破坏性变更）。
