"use client";

import {
  ActionRow,
  AppShell,
  Button,
  CellTitle,
  type Column,
  DangerZone,
  DangerZoneItem,
  DataTable,
  DesignProvider,
  ErrorDetail,
  Field,
  FilePicker,
  FilterChip,
  FormPage,
  FormSection,
  Grid,
  type HeaderAction,
  Icon,
  IconButton,
  IconGallery,
  type IconName,
  Input,
  type LinkComponent,
  ListPage,
  PageHeader,
  SecretReveal,
  Segmented,
  Select,
  SetupPage,
  SIZES,
  Sidebar,
  Stack,
  StatCards,
  StatusBar,
  StatusPage,
  SwitchField,
  SwitchList,
  Text,
  Textarea,
  useDesignLocale,
  useStatusBar,
} from "@capybara-hq/design";
import {
  CONNECTOR_STATUS_LABEL,
  type FixtureConnectorRow,
  type FixtureFormField,
  FORM_PAGE_FIXTURE,
  LIST_PAGE_FIXTURE,
  PAGE_HEADER_FIXTURE,
  STATUS_FIXTURE,
  TABLE_HOVER_ROW,
  TABLE_SELECTED_ROW,
} from "@capybara-hq/design/fixtures";
import { createContext, type ReactNode, useContext } from "react";
import { CONFIG_FORM_BLOCKS } from "./config-form-blocks";
import { CONVERSATION_BLOCKS } from "./conversation-blocks";
import { CONVERSATION_PAGE_BLOCKS } from "./conversation-page-blocks";
import { COMMANDS } from "./fixtures";
import { RefBlock } from "./ref-block";
import { type SidebarFixture, sidebarProps, statusFixture } from "./shell-fixture";
import { SetupHomeBody, setupFrameProps } from "./templates/setup";

// The /dev/ui side of the reference set (docs/design/reference/src): one RefBlock per state, with
// the reference block's id, box and fixture copy. Pseudo-states are forced by the Playwright specs.

const LIST = SIZES.layout.content;
const noop = () => {};
const LP = [{ label: "capybara", href: "/" }, { label: "connectors" }];

// ── Button ──────────────────────────────────────────────────────────────────

function ButtonRow({ density, disabled }: { density?: "dense" | "prominent"; disabled?: boolean }) {
  const d = density ? { density } : {};
  const icon = density === "dense" ? 14 : 16;
  return (
    <Stack direction="row" gap={12} align="center" wrap>
      <Button variant="primary" disabled={disabled} {...d}>
        新建 agent
      </Button>
      <Button variant="secondary" disabled={disabled} {...d}>
        部署
      </Button>
      <Button variant="default" disabled={disabled} {...d}>
        导出
      </Button>
      <Button variant="ghost" disabled={disabled} {...d}>
        取消
      </Button>
      <Button variant="danger" disabled={disabled} {...d}>
        删除
      </Button>
      <Button variant="default" disabled={disabled} {...d}>
        <Icon name="plus" size={14} />
        添加
      </Button>
      <IconButton
        variant="default"
        label="更多操作"
        icon={<Icon name="more-horizontal" size={icon} />}
        disabled={disabled}
        {...d}
      />
    </Stack>
  );
}

function buttonBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="button-default-step" width={720} pad>
        <ButtonRow />
      </RefBlock>
      <RefBlock id="button-dense-step" width={720} pad>
        <ButtonRow density="dense" />
      </RefBlock>
      <RefBlock id="button-prominent-step" width={720} pad>
        <ButtonRow density="prominent" />
      </RefBlock>
      <RefBlock id="button-hover" width={720} pad force={{ pseudo: ["hover"], selector: "button" }}>
        <ButtonRow />
      </RefBlock>
      <RefBlock
        id="button-focus"
        width={720}
        pad
        force={{ pseudo: ["focus", "focus-visible"], selector: "button" }}
      >
        <Stack direction="row" gap={12} align="center" wrap>
          <Button variant="primary">新建 agent</Button>
          <Button variant="default">导出</Button>
          <IconButton variant="default" label="更多操作" icon={<Icon name="more-horizontal" />} />
        </Stack>
      </RefBlock>
      <RefBlock id="button-disabled" width={720} pad>
        <ButtonRow disabled />
      </RefBlock>
      <RefBlock id="button-loading" width={720} pad>
        <Stack direction="row" gap={12} align="center" wrap>
          <Button variant="primary" loading>
            保存中
          </Button>
          <Button variant="default" loading>
            保存中
          </Button>
        </Stack>
      </RefBlock>
    </>
  );
}

// ── Input ───────────────────────────────────────────────────────────────────

function NameField({
  value,
  error,
  disabled,
}: {
  value: string;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field label="名称" {...(error ? { error } : {})}>
      <Input defaultValue={value} placeholder="输入名称" disabled={disabled} />
    </Field>
  );
}

function inputBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="input-default" width={720} pad itemWidth={320}>
        <NameField value="研究助手" />
        <NameField value="" />
      </RefBlock>
      <RefBlock
        id="input-focus"
        width={720}
        pad
        itemWidth={320}
        force={{ pseudo: ["focus-within"], selector: '[data-part="input"]' }}
      >
        <NameField value="研究助手" />
      </RefBlock>
      <RefBlock id="input-error" width={720} pad itemWidth={320}>
        <NameField value="" error="名称不能为空。" />
      </RefBlock>
      <RefBlock id="input-disabled" width={720} pad itemWidth={320}>
        <NameField value="研究助手" disabled />
      </RefBlock>
    </>
  );
}

// ── Segmented, switch, filter chip ─────────────────────────────────────────

const RANGES = ["1H", "24H", "7D", "30D"].map((v) => ({ value: v, label: v }));

function segmentedBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="segmented-default" width={360} pad>
        <Segmented label="时间范围" options={RANGES} value="1H" onChange={noop} />
      </RefBlock>
      <RefBlock id="segmented-selected" width={360} pad>
        <Segmented label="时间范围" options={RANGES} value="24H" onChange={noop} />
      </RefBlock>
      <RefBlock
        id="segmented-focus"
        width={360}
        pad
        force={{ pseudo: ["focus", "focus-visible"], selector: '[aria-checked="true"]' }}
      >
        <Segmented label="时间范围" options={RANGES} value="24H" onChange={noop} />
      </RefBlock>
    </>
  );
}

function SandboxSwitch({ on }: { on: boolean }) {
  return <SwitchField label="在沙箱里运行" checked={on} onChange={noop} />;
}

function switchBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="switch-default" width={360} pad>
        <SandboxSwitch on={false} />
      </RefBlock>
      <RefBlock id="switch-selected" width={360} pad>
        <SandboxSwitch on />
      </RefBlock>
      <RefBlock
        id="switch-focus"
        width={360}
        pad
        force={{ pseudo: ["focus", "focus-visible"], selector: '[data-part="switch"]' }}
      >
        <SandboxSwitch on />
      </RefBlock>
    </>
  );
}

function Chips({ selected }: { selected?: number }) {
  return (
    <Stack direction="row" gap={12} align="center" wrap>
      {LIST_PAGE_FIXTURE.chips.map((c, i) => (
        <FilterChip
          key={c.label}
          label={c.label}
          count={c.count}
          selected={i === selected}
          onSelect={noop}
        />
      ))}
    </Stack>
  );
}

function filterChipBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="filter-chip-default" width={480} pad>
        <Chips />
      </RefBlock>
      <RefBlock id="filter-chip-selected" width={480} pad>
        <Chips selected={0} />
      </RefBlock>
      <RefBlock
        id="filter-chip-focus"
        width={480}
        pad
        force={{
          pseudo: ["focus", "focus-visible"],
          selector: '[data-part="filter-chip"]:nth-child(2)',
        }}
      >
        <Chips selected={0} />
      </RefBlock>
    </>
  );
}

// ── Table ───────────────────────────────────────────────────────────────────

const STATUS_ICON: Partial<Record<FixtureConnectorRow["status"], IconName>> = {
  "needs-auth": "circle-alert",
  error: "circle-x",
  disabled: "ban",
};
const STATUS_TONE = {
  connected: "muted",
  "needs-auth": "warn",
  error: "fail",
  disabled: "muted",
} as const;

function StatusCell({ status }: { status: FixtureConnectorRow["status"] }) {
  const icon = STATUS_ICON[status];
  return (
    <Text tone={STATUS_TONE[status]}>
      <Stack direction="row" gap={4} align="center">
        {icon ? <Icon name={icon} size={12} /> : null}
        {CONNECTOR_STATUS_LABEL[status]}
      </Stack>
    </Text>
  );
}

const C = LIST_PAGE_FIXTURE.columns;
// The reference's column widths for a table `width` wide: the name 34%, the row-menu column 48
// (`control.dense` + 2 × `space.3`), and the five other columns share the rest equally.
function columnsFor(width: number): Column<FixtureConnectorRow>[] {
  const NAME_W = Math.round(width * 0.34);
  const COL_W = Math.round((width - NAME_W - (SIZES.control.dense + 2 * SIZES.space[3])) / 5);
  return [
    {
      key: "name",
      header: C.name,
      width: NAME_W,
      cell: (r) => (
        <CellTitle title={r.name} description={r.description} initial={r.name.slice(0, 1)} />
      ),
    },
    { key: "type", header: C.type, width: COL_W, tone: "muted", cell: (r) => r.type },
    {
      key: "status",
      header: C.status,
      width: COL_W,
      cell: (r) => <StatusCell status={r.status} />,
    },
    { key: "tools", header: C.tools, width: COL_W, align: "right", cell: (r) => r.tools },
    {
      key: "calls",
      header: C.calls7d,
      width: COL_W,
      align: "right",
      tone: "muted",
      cell: (r) => r.calls7d,
    },
    { key: "owner", header: C.owner, width: COL_W, tone: "muted", cell: (r) => r.owner },
  ];
}
const COLUMNS = columnsFor(LIST);

function ConnectorTable({
  rows = LIST_PAGE_FIXTURE.rows.length,
  state = "ready",
  activeKey,
}: {
  rows?: number;
  state?: "ready" | "loading" | "empty";
  activeKey?: string;
}) {
  return (
    <DataTable<FixtureConnectorRow>
      label={LIST_PAGE_FIXTURE.title}
      columns={COLUMNS}
      rows={state === "ready" ? LIST_PAGE_FIXTURE.rows.slice(0, rows) : []}
      rowKey={(r) => r.id}
      rowHeight="roomy"
      state={state === "loading" ? "loading" : "ready"}
      empty={{
        title: LIST_PAGE_FIXTURE.empty.title,
        action: <Button>{LIST_PAGE_FIXTURE.empty.action}</Button>,
      }}
      rowMenu={() => [{ label: "编辑", onSelect: noop }]}
      {...(activeKey ? { activeKey } : {})}
    />
  );
}

function tableBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="table-default" width={LIST}>
        <ConnectorTable />
      </RefBlock>
      <RefBlock
        id="table-row-hover"
        width={LIST}
        force={{ pseudo: ["hover"], selector: `tr[data-row-key="${TABLE_HOVER_ROW}"]` }}
      >
        <ConnectorTable rows={5} />
      </RefBlock>
      <RefBlock id="table-row-selected" width={LIST}>
        <ConnectorTable rows={5} activeKey={TABLE_SELECTED_ROW} />
      </RefBlock>
      <RefBlock id="table-loading" width={LIST}>
        <ConnectorTable state="loading" />
      </RefBlock>
      <RefBlock id="table-empty" width={LIST}>
        <ConnectorTable state="empty" />
      </RefBlock>
      {/* Phones: measured in a 390 window, where the rows stack (spec §6.6, §9.3). */}
      <RefBlock id="table-narrow" width={390}>
        <ConnectorTable rows={3} />
      </RefBlock>
    </>
  );
}

// ── Icon ────────────────────────────────────────────────────────────────────

function iconBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="icon-set-16" width={LIST} pad>
        <IconGallery size={16} />
      </RefBlock>
      <RefBlock id="icon-set-14" width={LIST} pad>
        <IconGallery size={14} />
      </RefBlock>
      <RefBlock id="icon-set-12" width={LIST} pad>
        <IconGallery size={12} />
      </RefBlock>
    </>
  );
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

const SIDEBAR_W = SIZES.layout.sidebar;
const SIDEBAR_H = 820;
/** Links stay on this page (`?at=<id>`), so the interaction spec can follow them. */
const here = (id: string) => `/dev/ui/reference/sidebar?at=${encodeURIComponent(id)}`;

function SidebarBlock({
  id,
  force,
  ...o
}: SidebarFixture & {
  id: string;
  force?: { pseudo: ("hover" | "focus" | "focus-visible")[]; selector: string };
}) {
  return (
    <RefBlock id={id} width={SIDEBAR_W} height={SIDEBAR_H} {...(force ? { force } : {})}>
      <Sidebar {...sidebarProps(o, here)} mode="full" />
    </RefBlock>
  );
}

const navAt = (id: string) => `[data-part="nav-item"][href*="at=${id}"]`;
const stepAt = (id: string) => `[data-part="step-item"][href*="at=${id}"]`;

/**
 * One link's navigation pending, the way next/link does it: the link provides its status and the
 * provider's `useLinkPending` reads it inside the link (LinkPendingMark).
 */
const PendingHere = createContext(false);
const usePendingHere = () => useContext(PendingHere);
function pendingLink(target: string): LinkComponent {
  return function PendingLink({ href, children, ...rest }) {
    return (
      <PendingHere.Provider value={href === target}>
        <a href={href} {...rest}>
          {children}
        </a>
      </PendingHere.Provider>
    );
  };
}
const PENDING_LINK = pendingLink(here("channels"));

/** The setup sidebar with the 连接渠道 step's navigation pending (its accent underline). */
function PendingSidebar() {
  const locale = useDesignLocale();
  return (
    <DesignProvider locale={locale} link={PENDING_LINK} useLinkPending={usePendingHere}>
      <Sidebar {...sidebarProps({ context: "setup", active: "agent" }, here)} mode="full" />
    </DesignProvider>
  );
}

/** Below 960: the setup home behind the scrim, the setup drawer open over it. */
function SetupDrawerPage() {
  return (
    <SetupPage
      {...setupFrameProps(here, "admin", "home")}
      title="开始之前"
      reference={{ drawer: true }}
    >
      <SetupHomeBody />
    </SetupPage>
  );
}

/** Below 960: the list page behind the scrim, the drawer open over it (the reference's stage). */
function DrawerPage() {
  const { onOpenCommands: _, ...sidebar } = sidebarProps(
    { active: "connectors", activeConversation: "cnv_r2" },
    here,
  );
  return (
    <AppShell
      sidebar={sidebar}
      commands={[]}
      status={statusFixture("/connectors")}
      title={LIST_PAGE_FIXTURE.title}
      reference={{ drawer: true }}
    >
      <ListPage
        header={{
          path: LP,
          title: LIST_PAGE_FIXTURE.title,
          description: LIST_PAGE_FIXTURE.description,
          metrics: LIST_PAGE_FIXTURE.metrics,
        }}
      />
    </AppShell>
  );
}

function sidebarBlocks(): ReactNode {
  const base = { active: "agents", activeConversation: "cnv_r2" };
  return (
    <>
      <SidebarBlock id="sidebar-default" {...base} />
      <SidebarBlock
        id="sidebar-item-hover"
        {...base}
        force={{ pseudo: ["hover"], selector: navAt("overview") }}
      />
      <SidebarBlock
        id="sidebar-item-focus"
        {...base}
        force={{ pseudo: ["focus", "focus-visible"], selector: navAt("inbox") }}
      />
      <SidebarBlock id="sidebar-conversation-active" activeConversation="cnv_r2" />
      <SidebarBlock id="sidebar-group-collapsed" {...base} collapsed={["agt_research"]} />
      <SidebarBlock
        id="sidebar-more-open"
        active="connectors"
        activeConversation="cnv_r2"
        moreOpen
      />
      <SidebarBlock id="sidebar-filter" {...base} filter={{ q: "", state: "waiting" }} />
      <SidebarBlock id="sidebar-archived" {...base} archived />
      <SidebarBlock id="sidebar-empty" {...base} state="empty" />
      <SidebarBlock id="sidebar-loading" {...base} state="loading" />
      <SidebarBlock id="sidebar-error" {...base} state="error" />
      <SidebarBlock
        id="sidebar-long-title"
        active="agents"
        activeConversation="cnv_l1"
        groups="long"
      />
      <SidebarBlock id="sidebar-many-groups" active="agents" groups="many" />
      <SidebarBlock id="sidebar-guest" {...base} level="guest" />
      <SidebarBlock id="sidebar-admin" context="admin" active="accounts" />
      <RefBlock
        id="sidebar-rail"
        width={200}
        height={SIDEBAR_H}
        force={{ pseudo: ["hover"], selector: navAt("agents") }}
      >
        <Sidebar {...sidebarProps({ active: "agents" }, here)} mode="rail" railTooltip="agents" />
      </RefBlock>
      <RefBlock id="sidebar-drawer" width={640} height={SIDEBAR_H}>
        <DrawerPage />
      </RefBlock>
      {/* The setup context (web-SSR spec §4) */}
      <SidebarBlock id="sidebar-setup" context="setup" active="agent" />
      <SidebarBlock id="sidebar-setup-waiting" context="setup" setup="member" active="home" />
      <SidebarBlock
        id="sidebar-setup-hover"
        context="setup"
        active="agent"
        force={{ pseudo: ["hover"], selector: stepAt("channels") }}
      />
      <SidebarBlock
        id="sidebar-setup-focus"
        context="setup"
        active="agent"
        force={{ pseudo: ["focus", "focus-visible"], selector: stepAt("model") }}
      />
      <RefBlock id="sidebar-setup-rail" width={240} height={SIDEBAR_H}>
        <Sidebar
          {...sidebarProps({ context: "setup", setup: "member", active: "home" }, here)}
          mode="rail"
          railTooltip="model"
        />
      </RefBlock>
      <RefBlock id="sidebar-setup-drawer" width={640} height={SIDEBAR_H}>
        <SetupDrawerPage />
      </RefBlock>
      <RefBlock id="sidebar-pending" width={SIDEBAR_W} height={SIDEBAR_H}>
        <PendingSidebar />
      </RefBlock>
    </>
  );
}

// ── Page header, stat cards, status bar, action row ──────────────────────

const L = LIST_PAGE_FIXTURE;
const F = FORM_PAGE_FIXTURE;
const ACTIONS: HeaderAction[] = [
  { label: L.secondaryAction, variant: "default" },
  { label: L.primaryAction, variant: "primary", icon: "plus" },
];

function pageHeaderBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="page-header-title" width={LIST} pad>
        <PageHeader path={F.path.slice(0, 1)} title={PAGE_HEADER_FIXTURE.title} />
      </RefBlock>
      <RefBlock id="page-header-path" width={LIST} pad>
        <PageHeader path={F.path} title={PAGE_HEADER_FIXTURE.pathTitle} />
      </RefBlock>
      <RefBlock id="page-header-description-actions" width={LIST} pad>
        <PageHeader path={LP} title={L.title} description={L.description} actions={ACTIONS} />
      </RefBlock>
      <RefBlock id="page-header-long-title" width={640} pad>
        <PageHeader
          path={LP}
          title={PAGE_HEADER_FIXTURE.longTitle}
          description={L.description}
          actions={ACTIONS}
        />
      </RefBlock>
      {/* Phones: measured in a 390 window: the search on its own line, the tabs scroll, 40 px
          tap targets (spec §4.2, §9.3). */}
      <RefBlock id="page-header-narrow" width={390} pad>
        <PageHeader
          path={F.path.slice(0, 1)}
          title={PAGE_HEADER_FIXTURE.title}
          actions={ACTIONS}
          tabs={PAGE_HEADER_FIXTURE.tabs}
          activeTab="all"
          search={{ label: PAGE_HEADER_FIXTURE.search, value: "", onChange: noop }}
        />
      </RefBlock>
    </>
  );
}

// Linked stat cards: only the first card links, so the forced state lands on one card.
const LINKED_METRICS = L.metrics.map((m, i) => (i === 0 ? { ...m, href: "/dev/ui" } : m));

function statCardsBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="stat-cards-four" width={LIST} pad>
        <StatCards metrics={L.metrics} />
      </RefBlock>
      <RefBlock id="stat-cards-five" width={LIST} pad>
        <StatCards metrics={L.metricsFive} />
      </RefBlock>
      <RefBlock id="stat-cards-tones" width={640} pad>
        <StatCards metrics={L.metrics} />
      </RefBlock>
      <RefBlock
        id="stat-cards-link-hover"
        width={640}
        pad
        force={{ pseudo: ["hover"], selector: 'a[data-part="stat-card"]' }}
      >
        <StatCards metrics={LINKED_METRICS} />
      </RefBlock>
      <RefBlock
        id="stat-cards-link-focus"
        width={640}
        pad
        force={{ pseudo: ["focus", "focus-visible"], selector: 'a[data-part="stat-card"]' }}
      >
        <StatCards metrics={LINKED_METRICS} />
      </RefBlock>
      {/* Phones: measured in a 390 window, two columns (spec §6.14, §9.3). */}
      <RefBlock id="stat-cards-narrow" width={390} pad>
        <StatCards metrics={L.metrics} />
      </RefBlock>
    </>
  );
}

function statusBarBlocks(): ReactNode {
  const S = STATUS_FIXTURE;
  return (
    <>
      <RefBlock id="status-bar-default" width={LIST}>
        <StatusBar
          context={S.context}
          pageStatus={S.pageStatus}
          system={S.system}
          version={S.version}
          timeZone={S.timeZone}
        />
      </RefBlock>
      <RefBlock id="status-bar-truncated" width={480}>
        <StatusBar
          context="grant@示例组织:/agents/跨部门季度经营分析与年度预算编制及执行情况跟踪复盘总结小助手/edit"
          pageStatus="当前版本 v12"
          system={S.system}
          version={S.version}
          timeZone={S.timeZone}
        />
      </RefBlock>
    </>
  );
}

function FormActionRow({ clean }: { clean?: boolean }) {
  return clean ? (
    <ActionRow unsaved={0} primary={{ label: F.actionRow.save, disabled: true, onSelect: noop }} />
  ) : (
    <ActionRow
      unsaved={2}
      errors={1}
      cancel={{ label: F.actionRow.discard, onSelect: noop }}
      primary={{ label: F.actionRow.save, onSelect: noop }}
    />
  );
}

function actionRowBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="action-row-unsaved-errors" width={LIST}>
        <FormActionRow />
      </RefBlock>
      <RefBlock id="action-row-clean" width={LIST}>
        <FormActionRow clean />
      </RefBlock>
    </>
  );
}

// ── Templates: the full shell in a 1280 × 820 block ─────────────────────────

const TEMPLATE_W = 1280;
const TEMPLATE_H = 820;
// The list template's table spans the content column: the block minus the sidebar and gutters.
const TEMPLATE_COLUMNS = columnsFor(TEMPLATE_W - SIZES.layout.sidebar - 2 * SIZES.layout.gutter);
const stay = (route: string) => () => route;

function ShellFixture({
  active,
  route,
  children,
}: {
  active: string;
  route: string;
  children?: ReactNode;
}) {
  const { onOpenCommands: _, ...sidebar } = sidebarProps({ active }, stay(`/dev/ui/${route}`));
  return (
    <AppShell sidebar={sidebar} commands={COMMANDS} status={statusFixture(route)}>
      {children}
    </AppShell>
  );
}

function ListTemplateBody() {
  useStatusBar(STATUS_FIXTURE.pageStatus);
  return (
    <ListPage
      header={{
        path: LP,
        title: L.title,
        description: L.description,
        metrics: L.metrics,
        actions: ACTIONS,
      }}
    >
      <DataTable<FixtureConnectorRow>
        label={L.title}
        columns={TEMPLATE_COLUMNS}
        rows={L.rows}
        rowKey={(r) => r.id}
        rowHeight="roomy"
        rowMenu={() => [{ label: "编辑", onSelect: noop }]}
        toolbar={
          <>
            <Input
              aria-label={L.searchPlaceholder}
              placeholder={L.searchPlaceholder}
              prefix={<Icon name="search" size={14} />}
            />
            {L.chips.map((c, i) => (
              <FilterChip
                key={c.label}
                label={c.label}
                count={c.count}
                selected={i === 0}
                onSelect={noop}
              />
            ))}
          </>
        }
        toolbarEnd={
          <Text variant="small" tone="muted">
            {L.sort}
          </Text>
        }
        pagination={{ page: 1, pageSize: L.rows.length, total: 24, onPage: noop }}
      />
    </ListPage>
  );
}

function FormFieldView({ f }: { f: FixtureFormField }) {
  switch (f.kind) {
    case "input":
      return (
        <Field
          label={f.label}
          {...(f.error ? { error: f.error } : {})}
          {...(f.optional ? { optional: true } : {})}
        >
          <Input defaultValue={f.value} />
        </Field>
      );
    case "textarea":
      return (
        <Field
          label={f.label}
          {...(f.optional ? { optional: true } : {})}
          {...(f.counter ? { count: { value: f.value.length, max: 8000 } } : {})}
        >
          <Textarea
            defaultValue={f.value}
            rows={f.mono ? 4 : 2}
            {...(f.mono ? { code: true } : {})}
          />
        </Field>
      );
    case "select":
      return (
        <Field label={f.label}>
          <Select options={[{ value: f.value, label: f.value }]} defaultValue={f.value} />
        </Field>
      );
    case "segmented":
      return (
        <Field label={f.label}>
          <Segmented
            fill
            label={f.label}
            options={f.options.map((o) => ({ value: o, label: o }))}
            value={f.options[f.selected] ?? ""}
            onChange={noop}
          />
        </Field>
      );
    case "switches":
      return (
        <SwitchList
          label="工具"
          rows={f.rows.map((r) => ({
            id: r.name,
            name: r.name,
            description: r.description,
            meta: r.policy,
            checked: r.on,
            onChange: noop,
          }))}
        />
      );
  }
}

function FormTemplateBody() {
  useStatusBar(F.status.pageStatus);
  return (
    <FormPage
      header={{ path: F.path, title: F.title }}
      actionRow={{
        unsaved: 2,
        errors: 1,
        cancel: { label: F.actionRow.discard, onSelect: noop },
        primary: { label: F.actionRow.save, onSelect: noop },
      }}
    >
      {F.sections.map((sec) => {
        const [a, b, ...rest] = sec.fields;
        const paired = a?.kind === "select" && b?.kind === "segmented";
        return (
          <FormSection
            key={sec.title}
            id={sec.title}
            title={sec.title}
            description={sec.description}
            flush={a?.kind === "switches"}
          >
            {paired ? (
              <Grid columns={2} gap={12}>
                <FormFieldView f={a} />
                <FormFieldView f={b} />
              </Grid>
            ) : null}
            {(paired ? rest : sec.fields).map((f) => (
              <FormFieldView key={f.id} f={f} />
            ))}
          </FormSection>
        );
      })}
    </FormPage>
  );
}

function templateListBlocks(): ReactNode {
  return (
    <RefBlock id="template-list-page" width={TEMPLATE_W} height={TEMPLATE_H}>
      <ShellFixture active="connectors" route="/connectors">
        <ListTemplateBody />
      </ShellFixture>
    </RefBlock>
  );
}

function templateFormBlocks(): ReactNode {
  return (
    <RefBlock
      id="template-form-page"
      width={TEMPLATE_W}
      height={TEMPLATE_H}
      force={{
        pseudo: ["focus-within"],
        selector: '[data-part="textarea"]:not(:has([data-code]))',
      }}
    >
      <ShellFixture active="agents" route="/agents/研究助手/edit">
        <FormTemplateBody />
      </ShellFixture>
    </RefBlock>
  );
}

// ── Role pass ───────────────────────────────────────────────────────────────

function noAccessBlocks(): ReactNode {
  return (
    <RefBlock id="no-access-default" width={720} pad>
      <StatusPage
        header={{ path: [{ label: "capybara" }, { label: "channels" }], title: "渠道" }}
        kind="no-access"
        title="没有访问权限"
        description="「渠道」只对组织管理员开放。"
        need="组织管理员"
        ask="如需访问，请联系本组织的管理员或所有者。"
      />
    </RefBlock>
  );
}

const DELETE_ITEM = (
  <DangerZoneItem
    title="删除组织"
    description="所有成员都会失去这个组织的访问，agent、会话与设置不再可用。"
    action={{ label: "删除组织…", onSelect: noop }}
  />
);

function dangerZoneBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="danger-zone-default" width={720} pad>
        <DangerZone title="危险操作">{DELETE_ITEM}</DangerZone>
      </RefBlock>
      <RefBlock id="danger-zone-two-items" width={720} pad>
        <DangerZone title="危险操作">
          <DangerZoneItem
            title="转让所有权"
            description="对方成为所有者，你成为管理员。"
            action={{ label: "转让…", onSelect: noop }}
          />
          {DELETE_ITEM}
        </DangerZone>
      </RefBlock>
    </>
  );
}

function secretRevealBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="secret-reveal-default" width={480} pad>
        <SecretReveal label="令牌" value="cap_svc_4f9c2a7e1b8d" />
      </RefBlock>
      <RefBlock id="secret-reveal-copied" width={480} pad>
        <SecretReveal label="令牌" value="cap_svc_4f9c2a7e1b8d" copied />
      </RefBlock>
    </>
  );
}

const RAW_REFRESH_ERROR =
  "https://github.com/capybara-hq/plugins.git: cannot list the refs of https://github.com/capybara-hq/plugins.git: Access to github.com is refused: it resolves to a private or reserved address (add the hostname to marketplaces.allowPrivateHosts to allow an internal host).";

function errorDetailBlocks(): ReactNode {
  const summary = "市场地址解析到内网或保留地址，已被网络规则拦截。";
  return (
    <>
      <RefBlock id="error-detail-default" width={640} pad>
        <ErrorDetail summary={summary} detail={RAW_REFRESH_ERROR} />
      </RefBlock>
      <RefBlock id="error-detail-open" width={640} pad>
        <ErrorDetail summary={summary} detail={RAW_REFRESH_ERROR} defaultOpen />
      </RefBlock>
    </>
  );
}

function filePickerBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="file-picker-default" width={640} pad>
        <FilePicker dropLabel="松开即选择" onFiles={noop} />
      </RefBlock>
      <RefBlock id="file-picker-chosen" width={640} pad>
        <FilePicker dropLabel="松开即选择" onFiles={noop}>
          <Text>plugin-todo-0.3.1.tgz · 48 KB</Text>
        </FilePicker>
      </RefBlock>
    </>
  );
}

export const REFERENCE_BLOCKS = {
  button: buttonBlocks,
  input: inputBlocks,
  segmented: segmentedBlocks,
  switch: switchBlocks,
  "filter-chip": filterChipBlocks,
  table: tableBlocks,
  icon: iconBlocks,
  sidebar: sidebarBlocks,
  "page-header": pageHeaderBlocks,
  "stat-cards": statCardsBlocks,
  "status-bar": statusBarBlocks,
  "action-row": actionRowBlocks,
  "template-list": templateListBlocks,
  "template-form": templateFormBlocks,
  ...CONVERSATION_BLOCKS,
  ...CONVERSATION_PAGE_BLOCKS,
  "no-access": noAccessBlocks,
  "danger-zone": dangerZoneBlocks,
  "secret-reveal": secretRevealBlocks,
  "error-detail": errorDetailBlocks,
  "file-picker": filePickerBlocks,
  ...CONFIG_FORM_BLOCKS,
} as const;
