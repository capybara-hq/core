---
name: writing-web-ui
description: 'Use when adding or changing UI under apps/web or packages/design: page = page template + design components, which template each page uses, the skeletons for ListPage + DataTable and FormPage + FormSection + ActionRow, what check:web-ui forbids (className / style / .css / color literals / low-level UI packages), the change flow for adding a component or template, and how to use /dev/ui and screenshot tests (visual-update).'
---

# Writing UI

Spec: `docs/design/spec.md` (the only spec). Implementation: `packages/design` (`@capybara-hq/design`); `apps/web` only consumes it.
The visual source of truth is the `/dev/ui` catalog page and the committed screenshot baselines (`apps/web/visual/`); `docs/design/reference/` (canvas export) does not exist at the moment, so don't look for it.

## Core rules

**Page = template + design components.** `apps/web` writes no styles: no `className`, `style`, `.css` or color literals; lay out with `Stack` / `Grid` / `Card` / `Text`, and colors come only from design tokens. When a component is missing, add it to the design package first (see "Adding a component or template" below); don't improvise one in a page.

## Choosing a template (spec §5)

| Page | Template | Notes |
|---|---|---|
| Org home, Agent summary | `OverviewPage` | Single |
| Agents / knowledge bases / plugins / members lists | `ListPage` | Rail (optional facet filters) + one `DataTable` |
| Agent / knowledge base / plugin detail | `DetailPage` | Content + Inspector, with PageTabs |
| Create / edit an object | `FormPage` | Centered, grouped by `FormSection`, always has an ActionRow |
| Org / environment / security settings | `SettingsPage` | Secondary nav + Centered, ActionRow when there are changes |
| Human approval, alert handling | `InboxPage` | Rail + Content (+ Inspector) |
| Trial-run an Agent in a conversation | `PlaygroundPage` | Content + Inspector (live trace) |
| Single run detail | `TracePage` | Span waterfall + detail |
| First-time setup of a model / connector / plugin | `WizardPage` | Centered + step bar, previous / next |
| Login, initialization, accept invitation | `AuthPage` | No Shell |
| 404 / 403 / under maintenance | `StatusPage` | Single, centered |
| New org, empty environment | `OnboardingPage` | Single, centered checklist |

### Templates for the admin console, evals and the enterprise directory (ready-made M6 examples)

| Page | Route | Template |
|---|---|---|
| Admin console overview | `/admin` | `OverviewPage` |
| Accounts, orgs, plugins, enterprise directory items, catalog browsing | `/admin/accounts`, `/admin/orgs`, `/admin/plugins`, `/admin/directory`, `/admin/directory/catalog` | `ListPage` |
| Plugin detail, directory item detail | `/admin/plugins/[name]`, `/admin/directory/[itemId]` | `DetailPage` (summary / permissions / config etc. use PageTabs) |
| Install a plugin, app bundle review | `/admin/plugins/install`, `/admin/directory/apps/review` | `WizardPage` |
| Deployment settings, models and prices, directory sources | `/admin/settings`, `/admin/models`, `/admin/directory/sources` | `SettingsPage` |
| Directory requests awaiting an enterprise admin decision | `/admin/directory/requests` | `InboxPage` |
| Trajectory list / eval set list | `/trajectories`, `/evals` | `ListPage` |
| Trajectory detail, eval case | `/trajectories/[conversationId]`, `/evals/[setId]/cases/[caseId]` | `TracePage`: `waterfall` holds `SpanWaterfall`, `detail` holds the selected span's detail |
| Eval set, eval run | `/evals/[setId]`, `/evals/runs/[runId]` | `DetailPage` |
| Create an eval set / start a run | `/evals/new`, `/evals/[setId]/run` | `FormPage` / `WizardPage` |
| Org-side enterprise directory, item detail, install | `/directory`, `/directory/[itemId]`, `/directory/[itemId]/install` | `ListPage` / `DetailPage` / `WizardPage` |

- Admin console pages are wrapped whole in `components/AdminGate`: for non-enterprise-admins it shows the `StatusPage` 403 and does not request `/api/v1/admin/*` (a UI-level block; the kernel is the final authority). The UI always says "enterprise admin".
- **`SpanWaterfall`**(spec §6.10)takes only plain props (`spans`, `selectedId`, `onSelect`, `labels`, `label`): each span's `kind` (`run` / `step` / `model` / `tool` / `wait`), `startMs` (relative to the earliest span), `durationMs` (null if unknown), `status`, `parentId`; the caller passes them in depth-first order. The page computes time and cost from the data the kernel returns (latency is derived from event times; cost is labeled "estimated").
- Permission review (install confirmation page, org plugin settings, app bundle review) shares `components/PermissionReview`; the purpose mapping shares `components/PurposeEditor`. Don't draw a second copy in a page.
- After the main table, a `ListPage` may carry a subordinate block (an `h2` + one `DataTable`, e.g. invitations on the members page); see spec §5.1.

Submit actions go in the ActionRow (built into `FormPage`, `WizardPage` etc.) and **must not** go in the PageHeader; at most one `variant: "primary"` per view, and at most 5 metrics (`PageHeader` throws in development and tests).

## Skeleton examples

List (`apps/web/src/app/[locale]/(app)/agents/page.tsx` is a real example):

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

Form (real examples: `agents/new/page.tsx`, `components/AgentForm.tsx`):

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

`ActionRowProps`: `{ unsaved?, errors?, cancel?, secondary?, primary }`; button spec `{ label, onSelect, shortcut?, loading?, disabled? }`. For the exact props of the controls in the examples, `packages/design/src/controls` and `/dev/ui` are authoritative (`Field` passes the aria associations for label, help and error to its child control). Use `useStatusBar(...)` for page status text; `useToast()` for toasts; in-app links go through the `DesignProvider` `link` (apps/web already passes next-intl's `Link`).

UI text goes through next-intl (`apps/web/messages/{zh,en}.json`); text inside design goes through design's own i18n.

## Forbidden (maps one-to-one to the `pnpm check:web-ui` rules)

Rule implementation: `tools/checks/src/web-ui.ts`; every rule has a violating-fixture test.

| Rule id | Forbidden | Use instead |
|---|---|---|
| `web-ui-import` | Importing blacklisted packages: `@radix-ui/*`, `cmdk`, `@emotion/*`, `@stitches/*`, `@vanilla-extract/*`, `@mui/*`, `@chakra-ui/*`, `@mantine/*`, `@headlessui/*`, `styled-components`, `antd`, `tailwindcss`, `tailwind-merge`, `clsx`, `classnames`, `class-variance-authority`, `styled-jsx`, `lucide-react`, `react-icons`; importing any `.css` other than `@capybara-hq/design/styles.css` | Use components exported by design; if one is missing, add it to the design package first |
| `web-ui-class-name` | `className` / `class` attributes (including `{...{ className }}` spreads and the props object of `createElement` / `jsx`) | Use design components or `Stack` / `Grid` / `Card` / `Text` |
| `web-ui-style` | `style` / `dangerouslySetInnerHTML` attributes, `<style>` elements (spreads and `createElement` included too) | Same as above; when new styles are needed, add them to the design package |
| `web-ui-iframe` | `<iframe>` elements, `createElement("iframe")` | Use `EmbedFrame` (sandbox fixed to `allow-scripts allow-forms`, forwards only this iframe's `message`) |
| `web-ui-color` | Any color notation: `#hex`, `rgb()` / `rgba()`, `hsl()` / `hsla()`, `hwb()`, `lab()` / `lch()` / `oklab()` / `oklch()`, `color()`, `color-mix()` | Colors come only from design tokens |
| `web-ui-css-file` | a `.css` file under `apps/web/src` | Put styles in `packages/design` |
| `web-ui-template` | a `src/app/**/page.tsx` that renders none of the 12 templates "imported from `@capybara-hq/design`" | Pick a §5 template as the skeleton |
| `design-color-literal` | `#hex` / `rgb()` / `hsl()` in `packages/design/src` outside `styles/tokens.css` (both CSS and TS strings are checked; `color-mix()` referencing tokens is allowed) | Define a token in `tokens.css` and use `var(--cb-…)` |

`web-ui-template` has two exemptions: `app/[locale]/dev/**` (the development catalog page; the other rules still apply), and pages that only handle 404 -- containing no JSX and calling `notFound()` imported from `next/navigation` (e.g. `(app)/[...rest]/page.tsx`), where the page is rendered by the `StatusPage` in the `not-found.tsx` of the same segment. Don't use this exemption to write other pages.

`web-ui-iframe` is a static check and only recognizes literals: `<iframe>` and `createElement("iframe")`. It cannot see dynamic tags (`const Tag = "iframe"; <Tag />`, `createElement(tag)`, names assembled for `document.createElement`), but the rule applies all the same -- don't work around it this way; review treats it as a violation.

Test files (`*.test.*`) are not checked. The package import rule is a blacklist: when introducing a new style / UI dependency, add it to `FORBIDDEN_PKG`.

## Adding a component or template

In order, don't skip steps (spec §10):

1. **Change the spec**: `docs/design/spec.md` (components in §6, templates in §5, tokens in §2), confirmed by review; sync the canvas if there is one.
2. **Implement**: `packages/design/src/…`, exported from `src/index.ts` (or the `index.ts` of the matching subdirectory); write styles in `src/styles/*.css` with tokens for colors; add tests (`packages/design/test/`, jsdom) covering states, keyboard and aria. A new template must also be added to `PAGE_TEMPLATES` in `src/templates/names.ts` and `WEB_UI_TEMPLATES` in `tools/checks/src/web-ui.ts` (a test keeps the two consistent).
3. **Catalog page**: in `apps/web/src/dev/catalog`, add all states of the component / the full page of the template (fixed fake data, light and dark).
4. **Update the screenshot baselines**: committed baselines contain only the Linux version, so trigger the GitHub Actions `visual-update` workflow on the PR branch (`workflow_dispatch`, with the branch name as the `branch` input); it generates and commits them inside the pinned Playwright Docker image. The PR attaches the diff images and merges after confirmation. Local darwin screenshots (`*-darwin.png`) are gitignored and only for local comparison; don't commit them.

## How to run

```bash
pnpm vitest run --project design          # component tests of the design package
pnpm check:web-ui                         # UI rule check (already part of pnpm check)
pnpm --filter @capybara-hq/web dev        # development; /zh/dev/ui is the component catalog page
CAPYBARA_DEV_UI=1 pnpm --filter @capybara-hq/web start   # enable /dev/ui in a production build (off by default)
pnpm --filter @capybara-hq/web visual     # screenshot regression (runs next build + start itself; local darwin differs from the baselines, for comparison only)
pnpm --filter @capybara-hq/web e2e        # real-stack e2e (Testcontainers, needs Docker)
```

Before changing `apps/web`, read `node_modules/next/dist/docs` (see `apps/web/AGENTS.md`; Next 16 has breaking changes).
