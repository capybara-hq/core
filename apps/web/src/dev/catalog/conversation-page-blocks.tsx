"use client";

import {
  AppShell,
  AttachmentStrip,
  BackgroundTasks,
  Button,
  ComposerBox,
  type ComposerBoxProps,
  ContextSection,
  ConversationPage,
  type ConversationPageProps,
  CsvPreview,
  FileCard,
  FilesSection,
  Icon,
  IconButton,
  InlineCard,
  PanelTabs,
  type PickerProps,
  PropertiesPanel,
  PropertySection,
  Prose,
  ReferenceBoard,
  RightPanel,
  type RightPanelSwitcher,
  Spinner,
  StatusBar,
  SubagentGroup,
  type SubagentRowData,
  SubagentTask,
  TaskList,
  TitleBar,
  type TitleBarPanel,
  type TitleBarProps,
  ToolGroup,
  UserBubble,
  untitledLabel,
  useDesignLocale,
} from "@capybara-hq/design";
import {
  CONV_COPY,
  CONV_FIXTURE,
  FILE_FIXTURE,
  type FixtureFile,
  type FixtureSubagent,
  PANEL_FIXTURE,
  PROSE_FIXTURE,
  SUBAGENT_FIXTURE,
  TOOL_FIXTURES,
} from "@capybara-hq/design/fixtures";
import { type ReactNode, useState } from "react";
import { Block, bytes, csvText, NOW, toRow } from "./conversation-blocks";
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
      status: f.status === "failed" ? "failed" : "completed",
      toolCalls: f.toolCalls,
      startedAt: start,
      finishedAt: start + d,
      ...(f.steps && f.result ? { summary: { steps: f.steps, result: f.result } } : {}),
    };
  });
}

function subagentGroupBlocks(): ReactNode {
  return (
    <>
      <Block id="subagent-group-running">
        <SubagentGroup rows={S.running.map(running)} onOpen={noop} now={NOW} />
      </Block>
      <Block id="subagent-group-done">
        <SubagentGroup rows={finished()} onOpen={noop} now={NOW} />
      </Block>
      <Block id="subagent-group-failed">
        <SubagentGroup rows={finished()} onOpen={noop} defaultOpen now={NOW} />
      </Block>
      <Block id="subagent-group-expanded">
        <SubagentGroup
          rows={finished()}
          onOpen={noop}
          defaultOpen
          defaultExpanded={[S.done[0]?.id ?? ""]}
          now={NOW}
        />
      </Block>
      <Block id="subagent-group-row-open">
        <SubagentGroup rows={S.running.map(running)} openId={S.open} onOpen={noop} now={NOW} />
      </Block>
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
    </>
  );
}

// ── Composer and pickers ────────────────────────────────────────────────────

type ComposerState = "idle" | "new" | "running" | "attachments" | "focus" | "no-effort";

function modelLabel(provider: string, id: string): string {
  return (
    C.models.find((g) => g.provider === provider)?.models.find((m) => m.id === id)?.label ?? id
  );
}

function pickers(state: ComposerState, open?: "agent" | "model" | "effort") {
  const model = state === "no-effort" ? C.noEffortModel : C.selected;
  const agent: PickerProps = {
    label: K.agent,
    value: C.agent.name,
    ...(state === "new" ? {} : { locked: { hint: K.agentLocked } }),
    groups: [
      { items: C.agents.map((a) => ({ id: a.id, label: a.name, checked: a.id === C.agent.id })) },
    ],
    note: K.agentLocked,
    onPick: noop,
    referenceOpen: open === "agent",
  };
  const modelPicker: PickerProps = {
    label: K.model,
    value: modelLabel(model.provider, model.model),
    groups: C.models.map((g, gi) => ({
      label: g.label,
      items: g.models.map((m, mi) => ({
        id: `${g.provider}/${m.id}`,
        label: m.label,
        ...(gi === 0 && mi === 0 ? { tag: "agent 默认" } : {}),
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
  return state === "no-effort"
    ? { agent, model: modelPicker }
    : { agent, model: modelPicker, effort };
}

function composerProps(
  state: ComposerState,
  open?: "agent" | "model" | "effort",
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
    ...(state === "running" ? { hint: K.queueHint } : {}),
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
    send:
      state === "running"
        ? { mode: "stop", onClick: noop }
        : { mode: "send", disabled: value === "", onClick: noop },
  };
}

function composerBlocks(): ReactNode {
  const states: ComposerState[] = ["idle", "new", "running", "attachments", "focus", "no-effort"];
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

function pickerMenuBlocks(): ReactNode {
  return (
    <>
      {(["model", "effort", "agent"] as const).map((m) => (
        <Block key={m} id={`picker-menu-${m}`} offsetTop={220}>
          <ComposerBox {...composerProps(m === "agent" ? "new" : "idle", m)} />
        </Block>
      ))}
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

function backgroundSection() {
  return (
    <PropertySection title="后台任务">
      <BackgroundTasks
        running={P.background.running.map((r, i) => ({
          id: `bg${i}`,
          name: r.name,
          elapsed: r.duration,
        }))}
        completed={P.background.completed}
        onStop={noop}
        onOpen={noop}
        onCompleted={noop}
      />
    </PropertySection>
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
            source: "Acme 文档",
            title: "搜索文件",
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

type TemplateState = "properties" | "file-panel" | "subagent-panel" | "new" | "sheet";

function thread(kind: "main" | "file" | "subagent"): ReactNode {
  if (kind === "subagent")
    return (
      <>
        <UserBubble text="有需要规整的吗？" />
        <Prose markdown="文件较多，我先让子 agent 列出完整目录树，同时对照流程实际读写的文件。" />
        <SubagentGroup rows={S.running.map(running)} openId={S.open} onOpen={noop} now={NOW} />
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
            title: "",
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
    state === "properties" ? "properties" : state === "new" ? "none" : "panel",
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
      {...(state === "sheet" ? { reference: { rail: true } as const } : {})}
    >
      <ConversationPage
        titleBar={titleBar}
        {...(isNew
          ? {
              newConversation: {
                agentName: C.agent.name,
                description: "检索资料、核对数据并整理成报告。",
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
        composer={<ComposerBox {...composerProps(isNew ? "new" : running ? "running" : "idle")} />}
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
        {...(live
          ? {}
          : {
              layout: state === "sheet" ? ("sheet" as const) : ("inline" as const),
              reference: true,
            })}
      />
    </AppShell>
  );
}

function templateConversationBlocks(): ReactNode {
  const states: TemplateState[] = ["properties", "file-panel", "subagent-panel", "new", "sheet"];
  return (
    <>
      {states.map((s) => (
        <RefBlock
          key={s}
          id={`template-conversation-${s}`}
          width={s === "sheet" ? 1100 : 1280}
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
  "title-bar": titleBarBlocks,
  composer: composerBlocks,
  "picker-menu": pickerMenuBlocks,
  "inline-card": inlineCardBlocks,
  "property-section": propertySectionBlocks,
  "right-panel": rightPanelBlocks,
  "template-conversation": templateConversationBlocks,
} as const;
