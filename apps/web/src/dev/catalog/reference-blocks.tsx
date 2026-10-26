"use client";

import {
  Button,
  CellTitle,
  type Column,
  DataTable,
  Field,
  FilterChip,
  Grid,
  Icon,
  IconButton,
  IconGallery,
  type IconName,
  Input,
  Segmented,
  SIZES,
  Stack,
  Switch,
  Text,
} from "@capybara-hq/design";
import {
  CONNECTOR_STATUS_LABEL,
  type FixtureConnectorRow,
  LIST_PAGE_FIXTURE,
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
      <RefBlock id="input-default" width={720} pad>
        <Grid columns={2} gap={12}>
          <NameField value="研究助手" />
          <NameField value="" />
        </Grid>
      </RefBlock>
      <RefBlock
        id="input-focus"
        width={720}
        pad
        force={{ pseudo: ["focus-within"], selector: '[data-part="input"]' }}
      >
        <Grid columns={2} gap={12}>
          <NameField value="研究助手" />
        </Grid>
      </RefBlock>
      <RefBlock id="input-error" width={720} pad>
        <Grid columns={2} gap={12}>
          <NameField value="" error="名称不能为空。" />
        </Grid>
      </RefBlock>
      <RefBlock id="input-disabled" width={720} pad>
        <Grid columns={2} gap={12}>
          <NameField value="研究助手" disabled />
        </Grid>
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
  return (
    <Stack direction="row" gap={8} align="center">
      <Switch label="在沙箱里运行" checked={on} onChange={noop} />
      <Text>在沙箱里运行</Text>
      <Text tone="muted">{on ? "已开启" : "已关闭"}</Text>
    </Stack>
  );
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
const COLUMNS: Column<FixtureConnectorRow>[] = [
  {
    key: "name",
    header: C.name,
    width: Math.round(LIST * 0.34),
    cell: (r) => (
      <CellTitle title={r.name} description={r.description} initial={r.name.slice(0, 1)} />
    ),
  },
  { key: "type", header: C.type, tone: "muted", cell: (r) => r.type },
  { key: "status", header: C.status, cell: (r) => <StatusCell status={r.status} /> },
  { key: "tools", header: C.tools, align: "right", cell: (r) => r.tools },
  { key: "calls", header: C.calls7d, align: "right", tone: "muted", cell: (r) => r.calls7d },
  { key: "owner", header: C.owner, tone: "muted", cell: (r) => r.owner },
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

export const REFERENCE_BLOCKS = {
  button: buttonBlocks,
  input: inputBlocks,
  segmented: segmentedBlocks,
  switch: switchBlocks,
  "filter-chip": filterChipBlocks,
  table: tableBlocks,
  icon: iconBlocks,
} as const;
