"use client";

import {
  AgentDetail,
  type AgentMapBackground,
  AgentMapDialog,
  type AgentMapNode,
  AgentMapTree,
  AgentRow,
  type AgentToolCallRow,
  AppShell,
  AttachmentStrip,
  type BackgroundItem,
  type BackgroundTaskItem,
  BackgroundTaskRow,
  BackgroundTasks,
  Button,
  CommandPalette,
  ComposerBox,
  type ComposerBoxProps,
  ContextSection,
  ConversationPage,
  type ConversationPageProps,
  CsvPreview,
  FileCard,
  FilesSection,
  Greeting,
  Icon,
  IconButton,
  InlineCard,
  PanelTabs,
  type PickerProps,
  PropertiesPanel,
  PropertySection,
  Prose,
  QuickActions,
  ReferenceBoard,
  RightPanel,
  type RightPanelSwitcher,
  SkeletonBars,
  Spinner,
  StatusBar,
  SubagentGroup,
  type SubagentRowData,
  SubagentTask,
  TaskList,
  TaskOutputPanel,
  TitleBar,
  type TitleBarPanel,
  type TitleBarProps,
  ToolGroup,
  TranscriptFrame,
  UserBubble,
  untitledLabel,
  useDesignLocale,
} from "@capybara-hq/design";
import {
  AGENT_MAP_FIXTURE,
  CONV_COPY,
  CONV_FIXTURE,
  FILE_FIXTURE,
  type FixtureFile,
  type FixtureSubagent,
  LONG_MODELS_FIXTURE,
  NEW_CONVERSATION_FIXTURE,
  PANEL_FIXTURE,
  PROSE_FIXTURE,
  SKILL_FIXTURE,
  SUBAGENT_FIXTURE,
  TOOL_FIXTURES,
} from "@capybara-hq/design/fixtures";
import { type ReactNode, useState } from "react";
import { FormError } from "../../components/form-error";
import { Block, bytes, csvText, NEW_CONVERSATION_AGENTS, NOW, toRow } from "./conversation-blocks";
import { COMMANDS } from "./fixtures";
import { RefBlock } from "./ref-block";
import { sidebarProps } from "./shell-fixture";

// The conversation-page frames of the reference set (docs/design/reference/src/conversation.js):
// sub-agent groups, the title bar, the composer and its pickers, inline cards, property sections,
// the right panel and the ConversationPage template, from the shared fixtures.

const noop = () => {};
const C = CONV_FIXTURE;
const K = CONV_COPY;
const S = SUBAGENT_FIXTURE;
const P = PANEL_FIXTURE;
const FI = FILE_FIXTURE;
const T = TOOL_FIXTURES;

/** "2分28秒" / "48 秒" → ms. */
function ms(d: string): number {
  const m = d.match(/(\d+)\s*分/);
  const s = d.match(/(\d+)\s*秒/);
  return ((m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0)) * 1000;
}

/** "10-26T14:32" wall-clock start of the untitled conversation, the same anywhere. */
function wallClock(iso: string): Date {
  const [y, mo, d, h, mi] = (iso.match(/\d+/g) ?? []).map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
}

// ── Sub-agents ──────────────────────────────────────────────────────────────

const running = (f: FixtureSubagent): SubagentRowData => ({
  id: f.id,
  agentType: f.agentType,
  description: f.description,
  prompt: f.prompt,
  ...(f.current !== undefined ? { current: f.current } : {}),
  status: "running",
  toolCalls: f.toolCalls,
  startedAt: NOW - ms(f.duration),
});

/**
 * Finished rows laid out so each row's duration is the fixture's and the group spans
 * `S.totals.duration` (from the first start to the last finish).
 */
function finished(): SubagentRowData[] {
  const span = ms(S.totals.duration);
  const t0 = NOW - span;
  return S.done.map((f, i) => {
    const d = ms(f.duration);
    const start = i === S.done.length - 1 ? t0 + span - d : t0 + i * 1000;
    return {
      id: f.id,
      agentType: f.agentType,
      description: f.description,
      prompt: f.prompt,
      status: f.status === "failed" ? "failed" : "completed",
      toolCalls: f.toolCalls,
      tokens: f.tokens,
      startedAt: start,
      finishedAt: start + d,
    };
  });
}

function subagentGroupBlocks(): ReactNode {
  return (
    <>
      <Block id="subagent-group-running">
        <SubagentGroup rows={S.running.map(running)} onOpen={noop} />
      </Block>
      <Block id="subagent-group-waiting">
        <SubagentGroup
          rows={S.running.map((f) => ({ ...running(f), status: "waiting", waiting: "approval" }))}
          onOpen={noop}
        />
      </Block>
      <Block id="subagent-group-done">
        <SubagentGroup rows={finished()} onOpen={noop} />
      </Block>
      <Block id="subagent-group-failed">
        <SubagentGroup rows={finished()} onOpen={noop} defaultOpen />
      </Block>
      <Block id="subagent-group-stopped">
        <SubagentGroup
          rows={finished().map((r, i) => (i === 1 ? { ...r, status: "aborted" } : r))}
          onOpen={noop}
          defaultOpen
        />
      </Block>
      <Block id="subagent-group-expanded">
        <SubagentGroup
          rows={finished()}
          onOpen={noop}
          defaultOpen
          defaultExpanded={[S.done[0]?.id ?? ""]}
        />
      </Block>
      <Block id="subagent-group-map-link">
        <SubagentGroup rows={S.running.map(running)} onOpen={noop} onOpenMap={noop} />
      </Block>
    </>
  );
}

// ── Agent map ───────────────────────────────────────────────────────────────

const AM = AGENT_MAP_FIXTURE;

const agentMapBackground: AgentMapBackground[] = AM.background.map((b) => ({
  kind: "task",
  id: b.id,
  description: b.description,
  status: b.status,
  startedAt: NOW - b.durationMs,
  ...(b.status === "running" ? {} : { finishedAt: NOW }),
}));

const AD = AM.detail;
const agentMapSelected = AM.root.children.find((c) => c.id === AM.selected) as AgentMapNode;
const agentMapCalls: AgentToolCallRow[] = AD.toolCalls.map((c) => ({
  id: c.id,
  tool: c.tool,
  summary: c.summary,
  running: c.running,
  ...(c.durationMs !== undefined ? { startedAt: NOW - c.durationMs } : {}),
  ...(c.range !== undefined ? { range: c.range } : {}),
}));
const agentMapDetailBackground: AgentMapBackground[] = AD.background.map((b) => ({
  kind: "task",
  id: b.id,
  description: b.description,
  status: b.status,
  startedAt: NOW - b.durationMs,
}));

function AgentMapDetailBlock({ finished, stopping }: { finished?: boolean; stopping?: boolean }) {
  const node: AgentMapNode = finished
    ? { ...agentMapSelected, status: "completed" }
    : agentMapSelected;
  const calls = finished ? agentMapCalls.map((c) => ({ ...c, running: false })) : agentMapCalls;
  return (
    <AgentMapDialog open inline onOpenChange={noop} level="detail">
      <AgentDetail
        node={node}
        agentType={AD.agentType}
        spawnedBy={AD.spawnedBy}
        latestText={AD.latestText}
        task={AD.task}
        background={agentMapDetailBackground}
        toolCalls={calls}
        onBack={noop}
        onClose={noop}
        onOpenParent={noop}
        onOpenTranscript={noop}
        {...(finished || stopping ? {} : { onStop: noop })}
        {...(stopping ? { stopping: true } : {})}
        now={NOW}
      />
    </AgentMapDialog>
  );
}

/** Level 3's thread: the conversation's own components, as the transcript builds them. */
function agentMapThread(): ReactNode {
  return (
    <>
      <UserBubble text={AD.task} />
      <Prose markdown="先读一季度的说明文件和发票目录。" />
      <ToolGroup
        rows={[
          { id: "tx1", kind: "read", name: "Read", keyArg: "finance/q1/README.md", status: "done" },
          {
            id: "tx2",
            kind: "command",
            name: "Bash",
            description: "列出一季度发票文件",
            status: "done",
          },
        ]}
      />
      <UserBubble text={AD.message} sender={AD.spawnedBy.label} />
      <Prose markdown="收到，只核对三月份的付款流水。" />
      <ToolGroup
        rows={[
          {
            id: "tx3",
            kind: "command",
            name: "Bash",
            description: "运行核对脚本",
            status: "running",
            startedAt: NOW - 12_000,
          },
        ]}
        now={NOW}
      />
    </>
  );
}

function agentMapBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="agent-map-tree" width={1132} height={580} pad>
        <AgentMapDialog open inline onOpenChange={noop} level="tree">
          <AgentMapTree
            root={AM.root}
            background={agentMapBackground}
            selectedId={AM.selected}
            onOpen={noop}
            now={NOW}
          />
        </AgentMapDialog>
      </RefBlock>
      <RefBlock id="agent-map-deep" width={1132} height={320} pad>
        <AgentMapDialog open inline onOpenChange={noop} level="tree">
          <AgentMapTree root={AM.deep} background={[]} onOpen={noop} now={NOW} />
        </AgentMapDialog>
      </RefBlock>
      {/* the page's own loading bars and error line, in the tree level's padded body */}
      <RefBlock id="agent-map-loading" width={1132} height={200} pad>
        <AgentMapDialog open inline onOpenChange={noop} level="tree">
          <SkeletonBars />
        </AgentMapDialog>
      </RefBlock>
      <RefBlock id="agent-map-failed" width={1132} height={140} pad>
        <AgentMapDialog open inline onOpenChange={noop} level="tree">
          <FormError message="智能体图加载失败。" />
        </AgentMapDialog>
      </RefBlock>
      <RefBlock id="agent-map-detail" width={786} height={632} pad>
        <AgentMapDetailBlock />
      </RefBlock>
      <RefBlock id="agent-map-finished" width={786} height={632} pad>
        <AgentMapDetailBlock finished />
      </RefBlock>
      <RefBlock id="agent-map-stopping" width={786} height={632} pad>
        <AgentMapDetailBlock stopping />
      </RefBlock>
      <RefBlock id="agent-map-transcript" width={786} height={672} pad>
        <AgentMapDialog open inline onOpenChange={noop} level="transcript">
          <TranscriptFrame
            node={agentMapSelected}
            agentType={AD.agentType}
            spawnedBy={AD.spawnedBy}
            onOpenParent={noop}
            contextPercent={AD.contextPercent}
            onBack={noop}
            onClose={noop}
            onStop={noop}
          >
            {agentMapThread()}
          </TranscriptFrame>
        </AgentMapDialog>
      </RefBlock>
    </>
  );
}

// ── Title bar ───────────────────────────────────────────────────────────────

function titleBarProps(o: { pressed?: string; title?: string | null } = {}): TitleBarProps {
  const base: TitleBarPanel[] = [
    { id: "files", label: K.files, icon: "file-text", pressed: false, onOpen: noop },
    { id: "todo", label: "待办", icon: "list-checks", pressed: false, onOpen: noop },
    { id: "board", label: "任务看板", icon: "extension", pressed: false, onOpen: noop },
  ];
  const panels = base.map((p) => ({ ...p, pressed: p.id === o.pressed }));
  return {
    title: o.title === undefined ? C.title : o.title,
    untitled: "",
    menu: [
      { id: "rename", label: K.rename, icon: "square-pen", onSelect: noop },
      { id: "copy", label: K.copyLink, icon: "link", onSelect: noop },
      "separator",
      { id: "delete", label: K.delete, icon: "trash-2", tone: "fail", onSelect: noop },
    ],
    properties: { pressed: o.pressed === "properties", onToggle: noop },
    panels,
  };
}

function UntitledBar() {
  const locale = useDesignLocale();
  return (
    <TitleBar
      {...titleBarProps({ title: null })}
      untitled={untitledLabel(wallClock(C.untitledAt), locale)}
    />
  );
}

function titleBarBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="title-bar-default" width={760}>
        <TitleBar {...titleBarProps()} />
      </RefBlock>
      <RefBlock id="title-bar-untitled" width={760}>
        <UntitledBar />
      </RefBlock>
      <RefBlock id="title-bar-rename-menu" width={760} height={200}>
        <TitleBar {...titleBarProps()} reference={{ titleMenu: true }} />
      </RefBlock>
      <RefBlock id="title-bar-panel-active" width={760}>
        <TitleBar {...titleBarProps({ pressed: "files" })} />
      </RefBlock>
      <RefBlock id="title-bar-overflow" width={760} height={200}>
        <TitleBar {...titleBarProps()} reference={{ visiblePanels: 1, moreMenu: true }} />
      </RefBlock>
      <RefBlock id="title-bar-long-title" width={760}>
        <TitleBar {...titleBarProps({ title: C.longTitle })} />
      </RefBlock>
      {/* Phones: measured in a 390 window, 40 px tap targets (spec §6.16.1, §9.3). */}
      <RefBlock id="title-bar-narrow" width={390}>
        <TitleBar {...titleBarProps()} />
      </RefBlock>
    </>
  );
}

// ── Composer and pickers ────────────────────────────────────────────────────

type ComposerState = "idle" | "new" | "running" | "attachments" | "focus" | "no-effort" | "skill";

function modelLabel(provider: string, id: string): string {
  return (
    C.models.find((g) => g.provider === provider)?.models.find((m) => m.id === id)?.label ?? id
  );
}

function pickers(state: ComposerState, open?: "agent" | "model" | "effort" | "long") {
  const model = state === "no-effort" ? C.noEffortModel : C.selected;
  const agent: PickerProps = {
    label: K.agent,
    value: C.agent.name,
    groups: [
      { items: C.agents.map((a) => ({ id: a.id, label: a.name, checked: a.id === C.agent.id })) },
    ],
    note: K.agentLocked,
    onPick: noop,
    referenceOpen: open === "agent",
  };
  const long = LONG_MODELS_FIXTURE;
  const longPicker: PickerProps = {
    label: K.model,
    value:
      long.groups.flatMap((g) => g.models).find((m) => m.id === long.selected)?.label ??
      long.selected,
    groups: long.groups.map((g) => ({
      label: g.label,
      items: g.models.map((m) => ({ id: m.id, label: m.label, checked: m.id === long.selected })),
    })),
    note: K.modelHint,
    onPick: noop,
    referenceOpen: true,
  };
  const modelPicker: PickerProps =
    open === "long"
      ? longPicker
      : {
          label: K.model,
          value: modelLabel(model.provider, model.model),
          groups: C.models.map((g, gi) => ({
            label: g.label,
            items: g.models.map((m, mi) => ({
              id: `${g.provider}/${m.id}`,
              label: m.label,
              ...(gi === 0 && mi === 0 ? { tag: "智能体默认" } : {}),
              checked: g.provider === model.provider && m.id === model.model,
            })),
          })),
          note: K.modelHint,
          onPick: noop,
          referenceOpen: open === "model",
        };
  const efforts = C.models[0]?.models[0]?.efforts ?? [];
  const effort: PickerProps = {
    label: K.effort,
    value: C.effortLabels[C.selected.effort] ?? C.selected.effort,
    groups: [
      {
        items: efforts.map((e) => ({
          id: e,
          label: C.effortLabels[e] ?? e,
          checked: e === C.selected.effort,
        })),
      },
    ],
    note: K.modelHint,
    onPick: noop,
    referenceOpen: open === "effort",
  };
  // the agent picker only in a new conversation: after the first message the title bar's path
  // names the agent (issue U)
  const agentPart = state === "new" ? { agent } : {};
  return state === "no-effort"
    ? { ...agentPart, model: modelPicker }
    : { ...agentPart, model: modelPicker, effort };
}

function composerProps(
  state: ComposerState,
  open?: "agent" | "model" | "effort" | "long",
): ComposerBoxProps {
  const value =
    state === "attachments"
      ? "帮我对一下这几个文件"
      : state === "focus"
        ? "再按收款人汇总一张表"
        : "";
  const [image, pdf] = FI.attachments;
  return {
    value,
    onChange: noop,
    placeholder:
      state === "new" ? K.newPlaceholder.replace("研究助手", C.agent.name) : K.placeholder,
    ...(state === "running" ? { hint: K.runningHint } : {}),
    ...(state === "attachments" && image && pdf
      ? {
          // The reference draws these chips without remove buttons; the product passes onRemove.
          attachments: (
            <AttachmentStrip
              items={[
                {
                  id: "a1",
                  kind: image.kind,
                  name: image.name,
                  size: bytes(image.size),
                },
                { id: "a2", kind: pdf.kind, name: pdf.name, size: bytes(pdf.size) },
              ]}
            />
          ),
        }
      : {}),
    onAttach: noop,
    pickers: pickers(state, open),
    ...(state === "skill" ? { token: { ...SKILL_FIXTURE.chip, onRemove: noop } } : {}),
    send:
      state === "running"
        ? { mode: "stop", onClick: noop }
        : // a picked skill can be sent without arguments
          { mode: "send", disabled: value === "" && state !== "skill", onClick: noop },
  };
}

function composerBlocks(): ReactNode {
  const states: ComposerState[] = [
    "idle",
    "new",
    "running",
    "attachments",
    "focus",
    "no-effort",
    "skill",
  ];
  return (
    <>
      {states.map((s) => (
        <Block
          key={s}
          id={`composer-${s}`}
          {...(s === "focus"
            ? { force: { pseudo: ["focus"], selector: '[data-part="composer-input"]' } }
            : {})}
        >
          <ComposerBox {...composerProps(s)} />
        </Block>
      ))}
    </>
  );
}

// ── Command palette (phase D: the `/` menu's tagged, searchable items) ────────

function commandPaletteBlocks(): ReactNode {
  const groups = SKILL_FIXTURE.groups.map((g) => ({
    label: g.label,
    items: g.items.map((it) => ({ ...it, onSelect: noop })),
  }));
  return (
    <>
      {(["skills", "filtered"] as const).map((s) => (
        <Block key={s} id={`command-palette-${s}`}>
          <CommandPalette
            open
            inline
            onOpenChange={noop}
            groups={groups}
            {...(s === "filtered" ? { defaultSearch: SKILL_FIXTURE.query } : {})}
          />
        </Block>
      ))}
    </>
  );
}

/** The composer of a new conversation (no agent picker) holding the agent's quick actions. */
function QuickActionsComposer({ open }: { open?: boolean }) {
  const { agent: _agent, ...rest } = composerProps("new").pickers;
  return (
    <ComposerBox
      {...composerProps("new")}
      pickers={rest}
      quickActions={
        <QuickActions
          items={NEW_CONVERSATION_FIXTURE.quickActions}
          onPick={noop}
          {...(open ? { referenceOpen: true } : {})}
        />
      }
    />
  );
}

/** The quick actions (§6.16.27): the zap button after the effort picker, and its menu above. */
function quickActionsBlocks(): ReactNode {
  return (
    <>
      <Block id="quick-actions-default">
        <QuickActionsComposer />
      </Block>
      <Block
        id="quick-actions-hover"
        force={{ pseudo: ["hover"], selector: '[data-part="quick-actions"]' }}
      >
        <QuickActionsComposer />
      </Block>
      {/* room above the composer for the menu, as the picker menus are staged */}
      <Block id="quick-actions-menu" offsetTop={220}>
        <QuickActionsComposer open />
      </Block>
    </>
  );
}

function pickerMenuBlocks(): ReactNode {
  return (
    <>
      {(["model", "effort", "agent"] as const).map((m) => (
        <Block key={m} id={`picker-menu-${m}`} offsetTop={220}>
          <ComposerBox {...composerProps(m === "agent" ? "new" : "idle", m)} />
        </Block>
      ))}
      {/* 100 models: the filter, the capped list scrolled to the checked one, the note kept */}
      <Block id="picker-menu-long" offsetTop={380}>
        <ComposerBox {...composerProps("idle", "long")} />
      </Block>
    </>
  );
}

// ── Inline card ─────────────────────────────────────────────────────────────

const tasks = P.tasks.items.map((t) => ({ text: t.text, state: t.state }));
const tasksBadge = `${P.tasks.done} / ${P.tasks.total}`;

function inlineCardBlocks(): ReactNode {
  const todo = P.extensions.todo.name;
  const board = P.extensions.board.name;
  return (
    <>
      <Block id="inline-card-view">
        <InlineCard source={todo} badge={tasksBadge} onExpand={noop} state="ready">
          <TaskList items={tasks} />
        </InlineCard>
      </Block>
      <Block id="inline-card-embed">
        <InlineCard source={board} live onExpand={noop} state="ready" embed>
          <ReferenceBoard columns={P.extensions.board.columns} />
        </InlineCard>
      </Block>
      <Block id="inline-card-loading">
        <InlineCard source={todo} onExpand={noop} state="loading" />
      </Block>
      <Block id="inline-card-failed">
        <InlineCard
          source={board}
          onExpand={noop}
          state="failed"
          failure={{ reason: P.extensions.failed.reason }}
          onRetry={noop}
        />
      </Block>
    </>
  );
}

// ── Properties ──────────────────────────────────────────────────────────────

const fileRows = FI.many.map((f) => ({ id: f.id, name: f.name, badge: f.type, size: f.size }));

function contextSection() {
  return (
    <ContextSection
      ratio={P.context.ratio}
      model={P.context.model}
      sandbox={P.context.sandbox}
      connectors={P.context.connectors}
    />
  );
}

function tasksSection() {
  return (
    <PropertySection title="待办" value={tasksBadge}>
      <TaskList items={tasks} />
    </PropertySection>
  );
}

function filesSection() {
  return <FilesSection files={fileRows} onOpen={noop} onAll={noop} />;
}

/** The fixture's running duration, "2:28". */
const RUNNING_MS = 148_000;
const ID = { running: "running", sandbox: "finished", event: "unavailable" } as const;
const BG_START = NOW - RUNNING_MS;

function backgroundSection() {
  return (
    <PropertySection title="后台任务">
      <BackgroundTasks
        items={[
          ...P.background.running.map(
            (r, i): BackgroundItem => ({
              kind: "subagent",
              id: `bg${i}`,
              name: r.name,
              status: "running",
              startedAt: NOW - RUNNING_MS,
            }),
          ),
          ...Array.from(
            { length: P.background.completed },
            (_, i): BackgroundItem => ({
              kind: "subagent",
              id: `bgdone${i}`,
              name: `已完成 ${i}`,
              status: "completed",
              startedAt: BG_START,
              finishedAt: BG_START + 1000 * (i + 1),
            }),
          ),
        ]}
        now={NOW}
        onStop={noop}
        onOpen={noop}
      />
    </PropertySection>
  );
}

const bgTask = (over: Partial<BackgroundTaskItem> = {}): BackgroundTaskItem => ({
  kind: "task",
  id: "bgt",
  description: "pnpm dev --port 3000",
  status: "running",
  startedAt: BG_START,
  ...over,
});

/** One finished task row inside its section, the way the section draws it. */
function finishedTask(status: BackgroundTaskItem["status"], exitCode: number | null) {
  return (
    <PropertySection title="后台任务">
      <BackgroundTaskRow
        item={bgTask({ status, exitCode, finishedAt: BG_START + 72_000 })}
        now={NOW}
        onStop={noop}
        onOpen={noop}
      />
    </PropertySection>
  );
}

function backgroundTaskBlocks(): ReactNode {
  return (
    <>
      <PropBlock id="background-task-running">
        <PropertySection title="后台任务">
          <BackgroundTasks
            items={[
              bgTask(),
              bgTask({ id: "bgt2", description: "tail -f build.log", stopping: true }),
            ]}
            now={NOW}
            onStop={noop}
            onOpen={noop}
          />
        </PropertySection>
      </PropBlock>
      <PropBlock id="background-task-waiting">
        <PropertySection title="后台任务">
          <BackgroundTasks
            items={[
              {
                kind: "subagent",
                id: "saw",
                name: "列出示例文档目录树",
                status: "waiting",
                waiting: "approval",
                startedAt: BG_START,
              },
            ]}
            now={NOW}
            onStop={noop}
            onOpen={noop}
          />
        </PropertySection>
      </PropBlock>
      <PropBlock id="background-task-done">{finishedTask("completed", 0)}</PropBlock>
      <PropBlock id="background-task-failed">{finishedTask("failed", 2)}</PropBlock>
      <PropBlock id="background-task-stopped">{finishedTask("stopped", null)}</PropBlock>
      <PropBlock id="background-task-lost">{finishedTask("lost", null)}</PropBlock>
      <PropBlock id="background-task-nested">
        <PropertySection title="后台任务">
          <BackgroundTasks
            items={[
              {
                kind: "subagent",
                id: "sa",
                name: "列出示例文档目录树",
                status: "running",
                startedAt: BG_START,
                tasks: [bgTask({ id: "bgn", nested: true })],
              },
            ]}
            now={NOW}
            onStop={noop}
            onOpen={noop}
          />
        </PropertySection>
      </PropBlock>
    </>
  );
}

function taskOutputBlocks(): ReactNode {
  const body = (
    status: BackgroundTaskItem["status"],
    source: "sandbox" | "event",
    elapsed: string,
    stopping = false,
  ) => (
    <RefBlock
      id={`task-output-panel-${stopping ? "stopping" : ID[status === "running" ? "running" : source]}`}
      width={420}
      pad
    >
      <TaskOutputPanel
        description="pnpm dev --port 3000"
        command="pnpm dev --port 3000"
        status={status}
        elapsed={elapsed}
        text={"ready in 412 ms\nlistening on http://localhost:3000"}
        source={source}
        stopping={stopping}
        onStop={noop}
      />
    </RefBlock>
  );
  return (
    <>
      {body("running", "sandbox", "2分28秒")}
      {body("running", "sandbox", "2分28秒", true)}
      {body("completed", "sandbox", "1分12秒")}
      {body("completed", "event", "1分12秒")}
    </>
  );
}

function PropBlock({ id, children }: { id: string; children: ReactNode }) {
  return (
    <RefBlock id={id} width={332} pad>
      <PropertiesPanel>{children}</PropertiesPanel>
    </RefBlock>
  );
}

function propertySectionBlocks(): ReactNode {
  return (
    <>
      <PropBlock id="property-section-context">{contextSection()}</PropBlock>
      <PropBlock id="property-section-files">{filesSection()}</PropBlock>
      <PropBlock id="property-section-background">{backgroundSection()}</PropBlock>
      <PropBlock id="property-section-extension">{tasksSection()}</PropBlock>
      <PropBlock id="property-section-failed">
        <PropertySection
          title="待办"
          state="failed"
          failure={{ reason: "扩展 10 秒内没有响应" }}
          onRetry={noop}
        />
      </PropBlock>
    </>
  );
}

function propertiesPanel() {
  return (
    <PropertiesPanel>
      {contextSection()}
      {tasksSection()}
      {filesSection()}
      {backgroundSection()}
    </PropertiesPanel>
  );
}

// ── Right panel ─────────────────────────────────────────────────────────────

const switcher = (current: string): RightPanelSwitcher => ({
  groups: [
    {
      label: "扩展",
      items: P.switcher
        .filter((x) => x.kind === "extension")
        .map((x) => ({
          id: x.label,
          label: x.label,
          icon: x.label === "待办" ? ("list-checks" as const) : ("extension" as const),
        })),
    },
    {
      label: K.files,
      items: P.switcher
        .filter((x) => x.kind === "file")
        .map((x) => ({ id: x.label, label: x.label, ...(x.type ? { badge: x.type } : {}) })),
    },
  ],
  current,
  onSwitch: noop,
});

/** The workbook's first sheet: the fixture rows, no count line. */
function sheetCsv(): string {
  return csvText().split("\n").slice(0, P.csvRows.length).join("\n");
}

function FilePanel({ switching }: { switching?: boolean }) {
  const f = FI.outputs[0] as FixtureFile;
  const [sheet, setSheet] = useState(FI.sheets[0] ?? "");
  return (
    <RightPanel
      title={f.name}
      badge={f.type}
      switcher={switcher(f.name)}
      referenceSwitcherOpen={switching === true}
      meta={`v${f.version ?? 1} · ${FI.updated}`}
      actions={
        <IconButton label={K.download} icon={<Icon name="download" size={16} />} onClick={noop} />
      }
      onFullscreen={noop}
      onClose={noop}
      body="flush"
    >
      <PanelTabs
        label="工作表"
        items={FI.sheets.map((s) => ({ id: s, label: s }))}
        current={sheet}
        onSelect={setSheet}
      />
      <CsvPreview text={sheetCsv()} delimiter="," />
    </RightPanel>
  );
}

function SubagentPanel() {
  const s = S.running[0] as FixtureSubagent;
  const SP = S.panel;
  return (
    <RightPanel
      title={s.description}
      onBack={noop}
      meta={
        <>
          <Spinner />
          {s.duration}
        </>
      }
      actions={<Button onClick={noop}>{K.stop}</Button>}
      onFullscreen={noop}
      onClose={noop}
      body="subagent"
      footer={<StatusBar context={SP.footer} version="" system={[`上下文 ${SP.context}`]} />}
    >
      <SubagentTask text={SP.task} agent="研究助手" model="opus 5.5" tools="只读工具" />
      <ToolGroup rows={T.expanded.slice(0, 3).map((t) => toRow(t))} />
      <Prose markdown={SP.prose} />
      <ToolGroup
        rows={[
          {
            id: "sub_current",
            kind: "connector",
            name: "Acme 文档",
            tool: "search_files",
            tooltip: "搜索文件",
            keyArg: SP.current,
            status: "running",
          },
        ]}
      />
    </RightPanel>
  );
}

function rightPanelBlocks(): ReactNode {
  const failed = P.extensions.failed;
  return (
    <>
      <RefBlock id="right-panel-extension" width={560} height={640}>
        <RightPanel
          title="待办"
          switcher={switcher("待办")}
          meta={tasksBadge}
          onFullscreen={noop}
          onClose={noop}
        >
          <TaskList items={tasks} size="large" />
        </RightPanel>
      </RefBlock>
      <RefBlock id="right-panel-file" width={560} height={640}>
        <FilePanel />
      </RefBlock>
      <RefBlock id="right-panel-subagent" width={560} height={640}>
        <SubagentPanel />
      </RefBlock>
      <RefBlock id="right-panel-switcher" width={560} height={640}>
        <FilePanel switching />
      </RefBlock>
      <RefBlock id="right-panel-failed" width={560} height={640}>
        <RightPanel
          title={failed.name}
          switcher={switcher(failed.name)}
          state="failed"
          failure={{ reason: failed.reason }}
          onRetry={noop}
          onFullscreen={noop}
          onClose={noop}
        />
      </RefBlock>
    </>
  );
}

// ── Template ────────────────────────────────────────────────────────────────

type TemplateState =
  | "properties"
  | "file-panel"
  | "subagent-panel"
  | "new"
  | "sheet"
  // the properties panel in the narrow sheet: its sections are heading and hairline groups
  | "properties-sheet"
  | "loading";

function thread(kind: "main" | "file" | "subagent"): ReactNode {
  if (kind === "subagent")
    return (
      <>
        <UserBubble text="有需要规整的吗？" />
        <Prose markdown="文件较多，我先让子智能体列出完整目录树，同时对照流程实际读写的文件。" />
        <SubagentGroup rows={S.running.map(running)} onOpen={noop} />
        <Prose markdown="目录树还在生成，我先整理当前版本流程引用的文件和文件夹 ID……" />
      </>
    );
  const card = FI.outputs[0] as FixtureFile;
  const fileCard = (
    <FileCard name={card.name} contentType="" size={bytes(card.size)} onOpen={noop} />
  );
  if (kind === "file")
    return (
      <>
        <UserBubble text="把差异整理成表格" />
        <ToolGroup rows={T.done.slice(0, 3).map((t) => toRow(t))} />
        <Prose markdown="整理好了，一共 14 行差异，按收款人汇总在第二个工作表：" />
        {fileCard}
      </>
    );
  return (
    <>
      <UserBubble text={C.user.text} />
      <ToolGroup rows={T.doneFailed.slice(0, 3).map((t) => toRow(t))} />
      <Prose markdown={`${PROSE_FIXTURE.streaming}。明细整理成了表格：`} />
      {fileCard}
      <ToolGroup
        rows={[
          {
            id: "main_current",
            kind: "command",
            name: "Bash",
            description: "正在核对总账",
            status: "running",
            startedAt: NOW - ms(C.stats.elapsed),
          },
        ]}
        now={NOW}
      />
    </>
  );
}

function TemplateBlock({ state, live }: { state: TemplateState; live?: boolean }) {
  const [right, setRight] = useState<ConversationPageProps["right"]>(
    state === "properties" || state === "properties-sheet"
      ? "properties"
      : state === "new"
        ? "none"
        : "panel",
  );
  const [panel, setPanel] = useState<string>(state === "subagent-panel" ? "subagent" : "files");
  const isNew = state === "new";
  const { onOpenCommands: _, ...sidebar } = sidebarProps(
    isNew ? { active: "new" } : { activeConversation: "cnv_r1", activeTitle: C.title },
    () => "/dev/ui/reference/template-conversation",
  );
  const pressed =
    right === "properties"
      ? "properties"
      : right === "panel" && panel !== "subagent"
        ? panel
        : undefined;
  const bar = titleBarProps(pressed ? { pressed } : {});
  const titleBar: TitleBarProps = {
    ...bar,
    properties: {
      pressed: right === "properties",
      onToggle: () => setRight((r) => (r === "properties" ? "none" : "properties")),
    },
    panels: bar.panels.map((p) => ({
      ...p,
      onOpen: () => {
        setPanel(p.id);
        setRight("panel");
      },
    })),
  };
  const X = C.stats;
  const running = state === "properties";
  const panelNode =
    panel === "subagent" ? (
      <SubagentPanel />
    ) : panel === "files" ? (
      <FilePanel />
    ) : (
      <RightPanel
        title={panel === "todo" ? "待办" : "任务看板"}
        onFullscreen={noop}
        onClose={() => setRight("none")}
      >
        <TaskList items={tasks} size="large" />
      </RightPanel>
    );
  return (
    <AppShell
      sidebar={sidebar}
      commands={COMMANDS}
      status={{ context: "", version: X.version }}
      ownStatusBar
      {...(state === "sheet" || state === "properties-sheet"
        ? { reference: { rail: true } as const }
        : {})}
    >
      <ConversationPage
        titleBar={titleBar}
        {...(isNew
          ? {
              // The new conversation page (agent profile design §4): the greeting and the agents
              // row over the composer, which holds the selected agent's quick actions.
              newConversation: {
                greeting: <Greeting text={NEW_CONVERSATION_FIXTURE.greeting} still />,
                agents: (
                  <AgentRow
                    agents={NEW_CONVERSATION_AGENTS}
                    selected={NEW_CONVERSATION_FIXTURE.selected}
                    recent={NEW_CONVERSATION_FIXTURE.recent}
                    onSelect={noop}
                  />
                ),
              },
            }
          : {})}
        thread={
          isNew
            ? null
            : thread(
                state === "subagent-panel" ? "subagent" : state === "properties" ? "main" : "file",
              )
        }
        composer={({ sendDisabled }) => {
          const c = composerProps(isNew ? "new" : running ? "running" : "idle");
          // the new conversation page chooses the agent in its row, not in the composer
          const { agent: _agent, ...pickers } = c.pickers;
          return (
            <ComposerBox
              {...c}
              pickers={isNew ? pickers : c.pickers}
              {...(isNew
                ? {
                    quickActions: (
                      <QuickActions items={NEW_CONVERSATION_FIXTURE.quickActions} onPick={noop} />
                    ),
                  }
                : {})}
              send={sendDisabled ? { ...c.send, disabled: true } : c.send}
            />
          );
        }}
        status={
          isNew
            ? { context: "grant@示例组织:/chat", version: X.version }
            : {
                context: C.path,
                stats: `第 ${X.turns} 轮 · 已用 ${X.elapsed}`,
                right: [
                  running || state === "subagent-panel" ? X.status : "空闲",
                  `上下文 ${X.context}`,
                ],
                version: X.version,
              }
        }
        properties={propertiesPanel()}
        panel={panelNode}
        right={right}
        onCloseRight={() => setRight("none")}
        // `loading`: the file-panel block with every part still on its way (spec §5.4).
        {...(state === "loading"
          ? { loading: { thread: true, title: true, rightArea: { title: "文件" } } }
          : {})}
        {...(live
          ? {}
          : {
              layout:
                state === "sheet" || state === "properties-sheet"
                  ? ("sheet" as const)
                  : ("inline" as const),
              reference: true,
            })}
      />
    </AppShell>
  );
}

function templateConversationBlocks(): ReactNode {
  const states: TemplateState[] = [
    "properties",
    "file-panel",
    "subagent-panel",
    "new",
    "sheet",
    "properties-sheet",
    "loading",
  ];
  return (
    <>
      {states.map((s) => (
        <RefBlock
          key={s}
          id={`template-conversation-${s}`}
          width={s === "sheet" || s === "properties-sheet" ? 1100 : 1280}
          height={820}
        >
          <TemplateBlock state={s} />
        </RefBlock>
      ))}
    </>
  );
}

/**
 * `/dev/ui/templates/conversation`: the template live at the window's width (the right area becomes
 * a sheet below 1280), with the file panel open; the interaction spec drives it.
 */
export function ConversationTemplateDemo() {
  return <TemplateBlock state="file-panel" live />;
}

export const CONVERSATION_PAGE_BLOCKS = {
  "subagent-group": subagentGroupBlocks,
  "agent-map": agentMapBlocks,
  "title-bar": titleBarBlocks,
  composer: composerBlocks,
  "command-palette": commandPaletteBlocks,
  "picker-menu": pickerMenuBlocks,
  "quick-actions": quickActionsBlocks,
  "inline-card": inlineCardBlocks,
  "property-section": propertySectionBlocks,
  "background-task": backgroundTaskBlocks,
  "task-output-panel": taskOutputBlocks,
  "right-panel": rightPanelBlocks,
  "template-conversation": templateConversationBlocks,
} as const;
