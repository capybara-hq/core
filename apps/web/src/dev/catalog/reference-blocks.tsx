"use client";

import {
  Button,
  CellTitle,
  type Column,
  DataTable,
  Field,
  FilterChip,
  Icon,
  IconButton,
  IconGallery,
  type IconName,
  Input,
  Segmented,
  SIZES,
  Sidebar,
  type SidebarGroup,
  type SidebarNavItem,
  type SidebarProps,
  Stack,
  SwitchField,
  Text,
} from "@capybara-hq/design";
import {
  CONNECTOR_STATUS_LABEL,
  EXTENSION_PAGES_FIXTURE,
  FIXTURE_ORG,
  FIXTURE_USER,
  type FixtureConnectorRow,
  type FixtureGroup,
  type FixtureNavItem,
  GROUPS_FIXTURE,
  LIST_PAGE_FIXTURE,
  LONG_TITLE_GROUP_FIXTURE,
  MANY_GROUPS_FIXTURE,
  MANY_GROUPS_MORE,
  NAV_FIXTURE,
  TABLE_HOVER_ROW,
  TABLE_SELECTED_ROW,
} from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// The /dev/ui side of the reference set (docs/design/reference/src): one RefBlock per state, with
// the reference block's id, box and fixture copy. Pseudo-states are forced by the Playwright specs.

const LIST = SIZES.layout["content-list"];
const noop = () => {};

// ── Button ──────────────────────────────────────────────────────────────────

function ButtonRow({ density, disabled }: { density?: "dense" | "prominent"; disabled?: boolean }) {
  const d = density ? { density } : {};
  const icon = density === "dense" ? 14 : 16;
  return (
    <Stack direction="row" gap={12} align="center" wrap>
      <Button variant="primary" disabled={disabled} {...d}>
        新建 Agent
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
          <Button variant="primary">新建 Agent</Button>
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
// The reference's column widths: the name 34% of the list width, the row-menu column 48
// (`control.dense` + 2 × `space.3`), and the five other columns share the rest equally.
const NAME_W = Math.round(LIST * 0.34);
const COL_W = Math.round((LIST - NAME_W - (SIZES.control.dense + 2 * SIZES.space[3])) / 5);
const COLUMNS: Column<FixtureConnectorRow>[] = [
  {
    key: "name",
    header: C.name,
    width: NAME_W,
    cell: (r) => (
      <CellTitle title={r.name} description={r.description} initial={r.name.slice(0, 1)} />
    ),
  },
  { key: "type", header: C.type, width: COL_W, tone: "muted", cell: (r) => r.type },
  { key: "status", header: C.status, width: COL_W, cell: (r) => <StatusCell status={r.status} /> },
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

const VISIBLE: Record<"guest" | "enterprise", FixtureNavItem["audience"][]> = {
  guest: ["all"],
  enterprise: ["all", "member", "admin", "enterprise"],
};

/** "2026-10-20T14:32:00+08:00" as that wall-clock time, so untitled labels read the same anywhere. */
function wallClock(iso: string): Date {
  const [y, mo, d, h, mi] = (iso.match(/\d+/g) ?? []).map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
}

const toGroup = (g: FixtureGroup): SidebarGroup => ({
  agentId: g.agentId,
  agentName: g.agentName,
  conversations: g.conversations.map((c) => ({
    id: c.id,
    title: c.title,
    startedAt: wallClock(c.startedAt),
    href: here(c.id),
  })),
  more: g.more,
  onMore: noop,
  onNew: noop,
});

function sidebarProps(o: {
  active?: string;
  activeConversation?: string;
  level?: "guest" | "enterprise";
  state?: "loading" | "error" | "empty";
  groups?: "long" | "many";
  collapsed?: string[];
}): SidebarProps {
  const visible = NAV_FIXTURE.filter((n) => VISIBLE[o.level ?? "enterprise"].includes(n.audience));
  const item = (n: FixtureNavItem): SidebarNavItem => ({
    id: n.id,
    label: n.label,
    href: here(n.id),
    icon: n.icon,
    ...(n.count !== undefined ? { count: n.count } : {}),
  });
  const footer = (n: FixtureNavItem) => n.id === "settings" || n.id === "admin";
  const groups =
    o.groups === "long"
      ? [LONG_TITLE_GROUP_FIXTURE, ...GROUPS_FIXTURE.slice(1)]
      : o.groups === "many"
        ? MANY_GROUPS_FIXTURE
        : GROUPS_FIXTURE;
  return {
    newConversation: { href: here("new") },
    nav: visible.filter((n) => !footer(n)).map(item),
    activeNav: o.active ?? "",
    extensions: EXTENSION_PAGES_FIXTURE.map((x) => ({ ...x, href: here(x.id) })),
    footerNav: visible.filter(footer).map(item),
    conversations: {
      state: o.state === "loading" || o.state === "error" ? o.state : "ready",
      groups: o.state === undefined ? groups.map(toGroup) : [],
      ...(o.activeConversation ? { activeId: o.activeConversation } : {}),
      moreGroups: o.groups === "many" && MANY_GROUPS_MORE,
      onMoreGroups: noop,
      onRetry: noop,
      collapsed: o.collapsed ?? [],
    },
    account: { name: FIXTURE_USER.name, org: FIXTURE_ORG, menu: [] },
    onOpenCommands: noop,
  };
}

function SidebarBlock({
  id,
  force,
  ...o
}: Parameters<typeof sidebarProps>[0] & {
  id: string;
  force?: { pseudo: ("hover" | "focus" | "focus-visible")[]; selector: string };
}) {
  return (
    <RefBlock id={id} width={SIDEBAR_W} height={SIDEBAR_H} {...(force ? { force } : {})}>
      <Sidebar {...sidebarProps(o)} mode="full" />
    </RefBlock>
  );
}

const navAt = (id: string) => `[data-part="nav-item"][href*="at=${id}"]`;

function sidebarBlocks(): ReactNode {
  const base = { active: "agents", activeConversation: "cnv_r2" };
  return (
    <>
      <SidebarBlock id="sidebar-default" {...base} />
      <SidebarBlock
        id="sidebar-item-hover"
        {...base}
        force={{ pseudo: ["hover"], selector: navAt("connectors") }}
      />
      <SidebarBlock
        id="sidebar-item-focus"
        {...base}
        force={{ pseudo: ["focus", "focus-visible"], selector: navAt("inbox") }}
      />
      <SidebarBlock id="sidebar-conversation-active" activeConversation="cnv_r2" />
      <SidebarBlock id="sidebar-group-collapsed" {...base} collapsed={["agt_research"]} />
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
      <RefBlock
        id="sidebar-rail"
        width={200}
        height={SIDEBAR_H}
        force={{ pseudo: ["hover"], selector: navAt("agents") }}
      >
        <Sidebar {...sidebarProps({ active: "agents" })} mode="rail" />
      </RefBlock>
      <RefBlock id="sidebar-drawer" width={640} height={SIDEBAR_H}>
        <Stack gap={16}>
          <Stack direction="row" gap={8} align="center">
            <IconButton label="打开导航" icon={<Icon name="menu" />} aria-expanded />
            <Text truncate>{LIST_PAGE_FIXTURE.title}</Text>
          </Stack>
          <Text variant="h1">{LIST_PAGE_FIXTURE.title}</Text>
          <Text tone="muted">{LIST_PAGE_FIXTURE.description}</Text>
        </Stack>
        <Sidebar
          {...sidebarProps({ active: "connectors", activeConversation: "cnv_r2" })}
          mode="drawer"
          drawer={{ open: true, onOpenChange: noop }}
          drawerInline
        />
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
} as const;
