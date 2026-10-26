---
name: writing-web-ui
description: 'Use when adding or changing UI under apps/web or packages/design: page = page template + design components, which template each page uses, the skeletons for ListPage + DataTable and FormPage + FormSection + ActionRow, what check:web-ui forbids (className / style / .css / color literals / low-level UI packages), the change flow for adding a component or template, and how to use /dev/ui and screenshot tests (visual-update).'
---

# Writing UI

Spec: `docs/design/spec.md` (the only spec). Implementation: `packages/design` (`@capybara-hq/design`); `apps/web` only consumes it.
The visual source is the **reference set** in `docs/design/reference/` (one PNG per component state, dark and light, drawn in `docs/design/reference/src/` from `docs/design/tokens.json`, the real fonts and `@capybara-hq/design/fixtures`; signed off 2026-10-26). New work is accepted against it (spec §9). The `/dev/ui` catalog and the committed screenshot baselines (`apps/web/visual/`) then guard against breakage.

Tokens: `docs/design/tokens.json` is the source; `pnpm gen:tokens` writes `tokens.css` / `tokens.ts` (never edit them), `pnpm check:tokens` checks them. Sizes are steps of the spec §2.5 scales; a container picks the density step (`density="dense" | "default" | "prominent"`, or `DensityContext`), pages never pick sizes.

## Core rules

**Page = template + design components.** `apps/web` writes no styles: no `className`, `style`, `.css` or color literals; lay out with `Stack` / `Grid` / `Card` / `Text`, and colors come only from design tokens. When a component is missing, add it to the design package first (see "Adding a component or template" below); don't improvise one in a page.

**Icons are components.** Use `<Icon name="search" size={14} />` (or an `IconButton` with an `Icon` and an `aria-label`) from `@capybara-hq/design`; never a character as an icon (`▾ ✓ ✕ ⋯ ⠿ ▤ ●`…; rule `design-char-icon`) and never an icon library in `apps/web`. A missing icon is added to `packages/design/scripts/gen-icons.mjs` (`pnpm --filter @capybara-hq/design gen:icons`).

## Choosing a template (spec §5)

| Page | Template | Notes |
|---|---|---|
| Org home, Agent summary | `OverviewPage` | Single |
| Agents / knowledge bases / extensions / members lists | `ListPage` | Rail (optional facet filters) + one `DataTable` |
| Agent / knowledge base / extension detail | `DetailPage` | Content + Inspector, with PageTabs |
| Create / edit an object | `FormPage` | Centered, grouped by `FormSection`, always has an ActionRow |
| Org / environment / security settings | `SettingsPage` | Secondary nav + Centered, ActionRow when there are changes |
| Human approval, alert handling | `InboxPage` | Rail + Content (+ Inspector) |
| The conversation page (`/chat`, `/chat/<id>`) | `ConversationPage` | Title bar + thread + composer, with the properties panel or one right panel (spec §5.4); replaces `PlaygroundPage`, which goes away when the page moves over |
| Single run detail | `TracePage` | Span waterfall + detail |
| First-time setup of a model / connector / extension | `WizardPage` | Centered + step bar, previous / next |
| Login, initialization, accept invitation | `AuthPage` | No Shell |
| 404 / 403 / under maintenance | `StatusPage` | Single, centered |
| New org, empty environment | `OnboardingPage` | Single, centered checklist |

### Templates for the admin console, evals and the catalog (ready-made M6 examples)

| Page | Route | Template |
|---|---|---|
| Admin console overview | `/admin` | `OverviewPage` |
| Accounts, orgs, extensions, catalog items, marketplace entries | `/admin/accounts`, `/admin/orgs`, `/admin/extensions`, `/admin/catalog`, `/admin/marketplaces/entries` | `ListPage` |
| Extension detail, catalog item detail | `/admin/extensions/[name]`, `/admin/catalog/[itemId]` | `DetailPage` (summary / permissions / config etc. use PageTabs) |
| Install an extension, plugin import review | `/admin/extensions/install`, `/admin/catalog/import` | `WizardPage` |
| Deployment settings, models and prices, marketplaces | `/admin/settings`, `/admin/models`, `/admin/marketplaces` | `SettingsPage` |
| Catalog requests awaiting an enterprise admin decision | `/admin/catalog/requests` | `InboxPage` |
| Trajectory list / eval set list | `/trajectories`, `/evals` | `ListPage` |
| Trajectory detail, eval case | `/trajectories/[conversationId]`, `/evals/[setId]/cases/[caseId]` | `TracePage`: `waterfall` holds `SpanWaterfall`, `detail` holds the selected span's detail |
| Eval set, eval run | `/evals/[setId]`, `/evals/runs/[runId]` | `DetailPage` |
| Create an eval set / start a run | `/evals/new`, `/evals/[setId]/run` | `FormPage` / `WizardPage` |
| Org-side catalog, item detail, install | `/catalog`, `/catalog/[itemId]`, `/catalog/[itemId]/install` | `ListPage` / `DetailPage` / `WizardPage` |

- Admin console pages are wrapped whole in `components/AdminGate`: for non-enterprise-admins it shows the `StatusPage` 403 and does not request `/api/v1/admin/*` (a UI-level block; the kernel is the final authority). The UI always says "enterprise admin".
- **`SpanWaterfall`**(spec §6.10)takes only plain props (`spans`, `selectedId`, `onSelect`, `labels`, `label`): each span's `kind` (`run` / `step` / `model` / `tool` / `wait`), `startMs` (relative to the earliest span), `durationMs` (null if unknown), `status`, `parentId`; the caller passes them in depth-first order. The page computes time and cost from the data the kernel returns (latency is derived from event times; cost is labeled "estimated").
- Permission review (install confirmation page, org extension settings, plugin review) shares `components/PermissionReview`; the purpose mapping shares `components/PurposeEditor`. Don't draw a second copy in a page.
- After the main table, a `ListPage` may carry a subordinate block (an `h2` + one `DataTable`, e.g. invitations on the members page); see spec §5.1.

### The conversation page

- **Pages never group tool calls themselves.** `apps/web/src/lib/timeline.ts` is the one pure builder that turns conversation events into timeline items (user bubbles, prose, thinking, tool groups, human-in-the-loop cards, file outputs, inline cards, sub-agent groups, dividers): consecutive tool calls become one group, a group ends at prose, a user message, a card or a divider, prose is never folded into a group. It is unit-tested with recorded logs, including a log written before UI refresh B (no `description`, no `view`, no title) that must render without errors.
- The page passes plain data to the design components of spec §6.16 (`ToolGroup`, `ToolRow`, `Prose`, `ApprovalBlock`, `FileCard` …) and keeps the container logic (`useChat`, cards with API calls) in `apps/web`. Tool rows read titles, kinds and key arguments from `GET …/conversations/:id/tools?keys=…` (`lib/tool-info.ts`), never by parsing tool keys.
- Copy: "文件" / "files" for what an agent delivers, never "产出物" / "artifacts"; tool verbs per kind come from the design i18n (spec §7).
- Extension blocks (inline card, properties section, right panel, previewer) fail alone: "Failed to load · Retry" in that block, the stream and the composer keep working.

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
  header={{
    breadcrumb: [{ label: t("agents.title"), href: "/agents" }],
    title: t("agents.form.title"),
  }}
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

`PageHeaderProps`: `{ breadcrumb?, title, description?, count?, status?, metrics?, actions? }` (metrics become StatCards, drawn by the template). Forms have no anchor navigation; the error count lives in the ActionRow. `ActionRowProps`: `{ unsaved?, errors?, cancel?, secondary?, primary }` (`unsaved: 0` reads "No unsaved changes"); button spec `{ label, onSelect, shortcut?, loading?, disabled? }`. For the exact props of the controls in the examples, `packages/design/src/controls` and `/dev/ui` are authoritative (`Field` passes the aria associations for label, help and error to its child control). Use `useStatusBar(...)` for page status text; `useToast()` for toasts; in-app links go through the `DesignProvider` `link` (apps/web already passes next-intl's `Link`).

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
| `design-char-icon` | A character used as an icon (`▾ ▴ ▸ ◂ ✓ ✗ ✕ ◐ › ‹ « » ● ○ ⠿ ▤ ⋯ ↻ ↗ ↕ ▲ ▼ ‖ ⊘ ◆ □ ■ ▶ ∅ ☰ ⚙ ⌕ ▦`) in a string, template literal or JSX text of non-test code in `apps/web/src` or `packages/design/src`, or in a value of `apps/web/messages/*.json`; the message names the icon to use. Box-drawing (`─ │ └`), `⌘`, `↵`, `→`, `·` and `…` are text and allowed | `<Icon name="chevron-down">` (or an `IconButton` with an `Icon`, `Text icon="circle-x"`, `MenuItem.checked`); keep the accessible name in text or `aria-label` |
| `design-color-literal` | `#hex` / `rgb()` / `hsl()` in `packages/design/src` outside `styles/tokens.css` (both CSS and TS strings are checked; `color-mix()` referencing tokens is allowed) | Define a token in `tokens.css` and use `var(--cb-…)` |

`web-ui-template` has two exemptions: `app/[locale]/dev/**` (the development catalog page; the other rules still apply), and pages that only handle 404 -- containing no JSX and calling `notFound()` imported from `next/navigation` (e.g. `(app)/[...rest]/page.tsx`), where the page is rendered by the `StatusPage` in the `not-found.tsx` of the same segment. Don't use this exemption to write other pages.

`web-ui-iframe` is a static check and only recognizes literals: `<iframe>` and `createElement("iframe")`. It cannot see dynamic tags (`const Tag = "iframe"; <Tag />`, `createElement(tag)`, names assembled for `document.createElement`), but the rule applies all the same -- don't work around it this way; review treats it as a violation.

Test files (`*.test.*`) are not checked. The package import rule is a blacklist: when introducing a new style / UI dependency, add it to `FORBIDDEN_PKG`.

## Adding a component or template

In order, don't skip steps (spec §10):

1. **Change the spec**: `docs/design/spec.md` (components in §6, templates in §5, tokens in §2), with the component's **state list** and **size table** in the spec §9.2 format (`<!-- states: x -->`, `<!-- size-table: x -->`; values are `tokens.json` paths); new tokens go into `docs/design/tokens.json` (then `pnpm gen:tokens`). Add a **reference block** per state to `docs/design/reference/src/` (`data-ref-block="<component>-<state>"`). Get the spec diff reviewed.
2. **Implement**: `packages/design/src/…`, exported from `src/index.ts` (or the `index.ts` of the matching subdirectory); write styles in `src/styles/*.css` with tokens for colors; add tests (`packages/design/test/`, jsdom) covering states, keyboard and aria. A new template must also be added to `PAGE_TEMPLATES` in `src/templates/names.ts` and `WEB_UI_TEMPLATES` in `tools/checks/src/web-ui.ts` (a test keeps the two consistent).
3. **Catalog page**: in `apps/web/src/dev/catalog`, add all states of the component / the full page of the template (fixed fake data from `@capybara-hq/design/fixtures`, light and dark), and a `RefBlock` per listed state with the **same id** as the reference block under `/dev/ui/reference/<component>`. Give the component's elements the `data-part` names the size table uses.
4. **Accept it**: `COMPARE=<component> pnpm --filter @capybara-hq/web compare` builds the reference | implementation side-by-side page (`apps/web/compare-out/index.html`, with `<id>-<theme>.ref.png` / `.impl.png` pairs). The pairs are then judged by a **blind image-reviewing subagent**, dispatched by the controller (the coordinating agent, not the implementer, who knows what changed): it gets only the PNG paths and the instruction "List every difference between each reference (left) and implementation (right) by severity: severe = different structure or layout, missing state, wrong color; moderate = size or spacing off; minor = rendering details. Cite the block id.", never a description of the change. Fix every severe and moderate difference and repeat; list the minor ones in the report. Then add the component to `ACCEPTED` in `apps/web/visual/accepted.ts` so `fidelity.spec.ts` measures it against the size table and checks state coverage (its completeness case fails while a component with a state list in the spec is in neither `ACCEPTED` nor `PENDING_B`; `PENDING_B` holds the conversation-page components while UI refresh B builds them, and a component moves from it to `ACCEPTED` when it passes). A difference that is right in the implementation and wrong in the reference goes through the spec §10 change process, never a quiet mismatch.
5. **Update the screenshot baselines**: committed baselines contain only the Linux version, so trigger the GitHub Actions `visual-update` workflow on the PR branch (`workflow_dispatch`, with the branch name as the `branch` input); it generates and commits them inside the pinned Playwright Docker image. The PR attaches the diff images and merges after confirmation. Local darwin screenshots (`*-darwin.png`) are gitignored and only for local comparison; don't commit them.

## How to run

```bash
pnpm vitest run --project design          # component tests of the design package
pnpm check:web-ui                         # UI rule check (already part of pnpm check)
pnpm --filter @capybara-hq/web dev        # development; /zh/dev/ui is the component catalog page
CAPYBARA_DEV_UI=1 pnpm --filter @capybara-hq/web start   # enable /dev/ui in a production build (off by default)
pnpm --filter @capybara-hq/web visual     # screenshot regression (runs next build + start itself; local darwin differs from the baselines, for comparison only)
pnpm --filter @capybara-hq/web visual fidelity      # measuring + state coverage against the spec size tables
COMPARE=button,table pnpm --filter @capybara-hq/web compare   # side-by-side page in apps/web/compare-out/
pnpm --filter @capybara-hq/web reference:render     # render the reference set PNGs locally (look only; CI commits them)
pnpm --filter @capybara-hq/web e2e        # real-stack e2e (Testcontainers, needs Docker)
```

Before changing `apps/web`, read `node_modules/next/dist/docs` (see `apps/web/AGENTS.md`; Next 16 has breaking changes).
