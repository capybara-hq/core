"use client";

import {
  ApprovalBlock,
  BubbleAttachments,
  ConnectBlock,
  type DiffData,
  type ForcedPseudo,
  Prose,
  QuestionBlock,
  QueuedMessage,
  QueuePaused,
  RunDivider,
  Stack,
  ThinkingRow,
  ToolBox,
  ToolGroup,
  ToolRow,
  type ToolRowData,
  UserBubble,
} from "@capybara-hq/design";
import {
  CONV_FIXTURE,
  DIVIDER_FIXTURE,
  FILE_FIXTURE,
  type FixtureTool,
  HITL_FIXTURE,
  PROSE_FIXTURE,
  QUEUE_FIXTURE,
  TOOL_FIXTURES,
} from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// The conversation-page blocks of the reference set (docs/design/reference/src/conversation.js):
// one RefBlock per state, 752 wide with the reference's padding, the content in a chat column.

const W = 752;
const noop = () => {};

function Block({
  id,
  force,
  children,
}: {
  id: string;
  force?: { pseudo: ForcedPseudo[]; selector: string };
  children: ReactNode;
}) {
  return (
    <RefBlock id={id} width={W} pad {...(force ? { force } : {})}>
      <Stack gap={4}>{children}</Stack>
    </RefBlock>
  );
}

// ── Prose ───────────────────────────────────────────────────────────────────

const PATHS = new Set(FILE_FIXTURE.paths);

function proseBlocks(): ReactNode {
  return (
    <>
      <Block id="prose-markdown">
        <Prose markdown={PROSE_FIXTURE.markdown} />
      </Block>
      <Block id="prose-streaming">
        <Prose markdown={PROSE_FIXTURE.streaming} streaming />
      </Block>
      <Block id="prose-file-chip">
        <Prose markdown={PROSE_FIXTURE.withPaths} paths={PATHS} onOpenPath={noop} />
      </Block>
    </>
  );
}

// ── Thinking ────────────────────────────────────────────────────────────────

function thinkingRowBlocks(): ReactNode {
  const P = PROSE_FIXTURE;
  return (
    <>
      <Block id="thinking-row-collapsed">
        <ThinkingRow seconds={P.thinkingSeconds} text={P.thinking} />
      </Block>
      <Block id="thinking-row-expanded">
        <ThinkingRow seconds={P.thinkingSeconds} text={P.thinking} defaultOpen />
      </Block>
      <Block id="thinking-row-live">
        <ThinkingRow seconds={4} text={P.thinking.slice(0, 22)} live />
      </Block>
    </>
  );
}

// ── User bubble ─────────────────────────────────────────────────────────────

function userBubbleBlocks(): ReactNode {
  const [image, pdf] = FILE_FIXTURE.attachments;
  const items = [
    { id: "a1", kind: "image" as const, name: image?.name ?? "" },
    { id: "a2", kind: "image" as const, name: image?.name ?? "" },
    {
      id: "a3",
      kind: "file" as const,
      name: pdf?.name ?? "",
      type: pdf?.type ?? "",
      size: pdf?.size ?? "",
    },
  ];
  return (
    <>
      <Block id="user-bubble-default">
        <UserBubble text={CONV_FIXTURE.user.text} />
      </Block>
      <Block id="user-bubble-attachments">
        <UserBubble
          text="帮我对一下这几个文件"
          attachments={<BubbleAttachments items={items} onOpen={noop} />}
        />
      </Block>
    </>
  );
}

// ── Run divider ─────────────────────────────────────────────────────────────

function runDividerBlocks(): ReactNode {
  const D = DIVIDER_FIXTURE;
  const compacted = `较早的对话已压缩 · 节省 ${D.compacted.saved}`;
  return (
    <>
      <Block id="run-divider-stopped">
        <RunDivider kind="stopped" text={`已停止 · ${D.stopped.who} ${D.stopped.at}`} />
      </Block>
      <Block id="run-divider-failed">
        <RunDivider
          kind="failed"
          text={`运行失败：${D.failed.reason}`}
          action={{ onClick: noop }}
        />
      </Block>
      <Block id="run-divider-compacted">
        <RunDivider kind="compacted" text={compacted} action={{ onClick: noop, expanded: false }} />
      </Block>
      <Block id="run-divider-compacted-open">
        <RunDivider kind="compacted" text={compacted} action={{ onClick: noop, expanded: true }}>
          {D.compacted.summary}
        </RunDivider>
      </Block>
      <Block id="run-divider-fallback">
        <RunDivider
          kind="fallback"
          text={`所选模型 ${D.fallback.from} 已不可用，本条起改用 agent 的模型 ${D.fallback.to}`}
        />
      </Block>
      <Block id="run-divider-hook-denied">
        <RunDivider
          kind="hook-denied"
          text={`运行被扩展「${D.hookDenied.extension}」拦截：${D.hookDenied.reason}`}
        />
      </Block>
    </>
  );
}

// ── Tools ───────────────────────────────────────────────────────────────────

/** A fixed clock, so running rows read the fixture's elapsed time. */
const NOW = Date.UTC(2026, 9, 26, 6, 32, 12);

function fixtureDiff(t: FixtureTool, truncated = false): DiffData | undefined {
  const lines = t.diff;
  if (!lines || lines.length === 0) return undefined;
  const first = lines[0];
  return {
    hunks: [
      {
        oldStart: first?.old ?? 0,
        newStart: first?.new ?? 0,
        lines: lines.map((l) => ({ kind: l.kind, text: l.text })),
      },
    ],
    truncated,
    ...(truncated ? { totalLines: 10_000 } : {}),
  };
}

/** A fixture call as the timeline builder hands it to the design components. */
function toRow(t: FixtureTool, o: { truncated?: boolean; blockedBy?: string } = {}): ToolRowData {
  const shell = t.kind === "command" && t.title !== "";
  const diff = fixtureDiff(t, o.truncated);
  const detail: NonNullable<ToolRowData["detail"]> = {
    ...(t.input ? { input: t.input } : {}),
    ...(t.command ? { command: t.command } : {}),
    ...(t.output ? { output: t.output } : {}),
    ...(t.outputBytes ? { outputBytes: t.outputBytes, outputShownBytes: 4 * 1024 } : {}),
    ...(diff ? { diff } : {}),
  };
  return {
    id: t.id,
    kind: t.kind,
    title: shell ? "" : t.title,
    status: t.status,
    ...(shell ? { description: t.title } : {}),
    ...(t.source ? { source: t.source } : {}),
    ...(t.keyArg ? { keyArg: t.keyArg } : {}),
    ...(t.extra ? { extra: t.extra } : {}),
    ...(t.status === "running" ? { startedAt: NOW - 12_000 } : {}),
    ...(t.durationMs !== undefined ? { durationMs: t.durationMs } : {}),
    ...(t.added !== undefined ? { added: t.added, removed: t.removed ?? 0 } : {}),
    ...(o.blockedBy ? { blockedBy: o.blockedBy } : t.error ? { error: t.error } : {}),
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  };
}

const T = TOOL_FIXTURES;
const rows = (list: FixtureTool[]) => list.map((t) => toRow(t));
const pick = (list: FixtureTool[], i: number): FixtureTool => {
  const t = list[i];
  if (!t) throw new Error(`fixture ${i} missing`);
  return t;
};

function toolGroupBlocks(): ReactNode {
  return (
    <>
      <Block id="tool-group-single">
        <Stack gap={8}>
          {T.single.map((t) => (
            <ToolGroup key={t.id} rows={[toRow({ ...t, input: [["q", t.keyArg ?? ""]] })]} />
          ))}
        </Stack>
      </Block>
      <Block id="tool-group-running">
        <ToolGroup rows={rows(T.running)} now={NOW} />
      </Block>
      <Block id="tool-group-collapsed">
        <ToolGroup rows={rows(T.done)} />
      </Block>
      <Block id="tool-group-collapsed-failed">
        <ToolGroup rows={rows(T.doneFailed)} />
      </Block>
      <Block id="tool-group-one-object">
        <ToolGroup rows={rows(T.oneObject)} />
      </Block>
      <Block id="tool-group-expanded">
        <ToolGroup
          rows={rows(T.expanded)}
          open
          defaultOpenRows={["t_exp_conn", "t_exp_cmd"]}
          onCopy={noop}
        />
      </Block>
      <Block id="tool-group-edited">
        <ToolGroup rows={rows(T.diff)} />
      </Block>
    </>
  );
}

function RowBlock({
  id,
  row,
  open,
  force,
}: {
  id: string;
  row: ToolRowData;
  open?: boolean;
  force?: "hover" | "focus";
}) {
  return (
    <Block
      id={id}
      {...(force
        ? {
            force: {
              pseudo: force === "hover" ? ["hover"] : ["focus", "focus-visible"],
              selector: '[data-part="tool-row"]',
            },
          }
        : {})}
    >
      <ToolBox>
        <ToolRow row={row} open={open === true} onCopy={noop} onViewAll={noop} now={NOW} />
      </ToolBox>
    </Block>
  );
}

function toolRowBlocks(): ReactNode {
  const perm = toRow(pick(T.expanded, 2));
  return (
    <>
      <RowBlock id="tool-row-default" row={perm} />
      <RowBlock id="tool-row-hover" row={perm} force="hover" />
      <RowBlock id="tool-row-focus" row={perm} force="focus" />
      <RowBlock id="tool-row-running" row={toRow(pick(T.running, 2))} />
      <RowBlock id="tool-row-failed" row={toRow(pick(T.expanded, 3))} />
      <RowBlock id="tool-row-expanded-command" row={toRow(pick(T.expanded, 4))} open />
      <RowBlock id="tool-row-expanded-connector" row={toRow(pick(T.expanded, 1))} open />
      <RowBlock id="tool-row-expanded-failed" row={toRow(pick(T.expanded, 3))} open />
      <RowBlock id="tool-row-large-output" row={toRow(pick(T.largeOutput, 0))} open />
      <RowBlock
        id="tool-row-hook-denied"
        row={toRow(pick(T.hookDenied, 0), { blockedBy: "合规审查" })}
        open
      />
    </>
  );
}

function diffBlockBlocks(): ReactNode {
  const t = pick(T.diff, 0);
  return (
    <>
      <Block id="diff-block-default">
        <ToolGroup rows={[toRow(t)]} open />
      </Block>
      <Block id="diff-block-truncated">
        <ToolGroup rows={[toRow(t, { truncated: true })]} open onViewAll={noop} />
      </Block>
    </>
  );
}

// ── Human in the loop ───────────────────────────────────────────────────────

const H = HITL_FIXTURE;

function ApprovalPending({
  id,
  scopes,
  deny,
}: {
  id: string;
  scopes: ("once" | "session" | "always")[];
  deny?: boolean;
}) {
  const A = H.approval;
  return (
    <Block
      id={id}
      {...(deny
        ? { force: { pseudo: ["focus-within"] as ForcedPseudo[], selector: '[data-part="input"]' } }
        : {})}
    >
      <ApprovalBlock
        tool={A.tool}
        toolKey={A.toolKey}
        input={Object.fromEntries(A.args)}
        scopes={scopes}
        policy={A.policy}
        state={{ kind: "pending" }}
        onApprove={noop}
        onDeny={noop}
        {...(deny ? { defaultDeny: { reason: A.denyReason } } : {})}
      />
    </Block>
  );
}

function approvalBlocks(): ReactNode {
  const W = H.decided;
  const A = H.approval;
  return (
    <>
      <ApprovalPending id="approval-block-pending" scopes={A.scopes} />
      <ApprovalPending id="approval-block-pending-once" scopes={["once"]} />
      <ApprovalPending id="approval-block-deny-reason" scopes={A.scopes} deny />
      <Block id="approval-block-approved">
        <ApprovalBlock
          tool={W.approved.tool}
          toolKey={W.approved.toolKey}
          input={{}}
          scopes={A.scopes}
          state={{
            kind: "decided",
            decision: "approved",
            who: W.who,
            when: W.approved.at,
            scope: "once",
          }}
        />
      </Block>
      <Block id="approval-block-denied">
        <ApprovalBlock
          tool={W.denied.tool}
          toolKey={W.denied.toolKey}
          input={{}}
          scopes={A.scopes}
          state={{
            kind: "decided",
            decision: "denied",
            who: W.who,
            when: W.denied.at,
            reason: W.denied.reason,
          }}
        />
      </Block>
    </>
  );
}

function questionBlocks(): ReactNode {
  const Q = H.question;
  const field = {
    key: "category",
    label: Q.question,
    kind: "enum" as const,
    options: Q.options,
    allowOther: true,
  };
  return (
    <>
      <Block id="question-block-pending">
        <QuestionBlock
          title={Q.question}
          fields={[field]}
          state={{ kind: "pending" }}
          defaultDraft={{ category: Q.options[Q.selected] ?? "" }}
          onAnswer={noop}
          onSkip={noop}
        />
      </Block>
      <Block id="question-block-url">
        <QuestionBlock
          title={H.questionUrl.question}
          url={H.questionUrl.url}
          fields={[]}
          state={{ kind: "pending" }}
          onAnswer={noop}
          onSkip={noop}
        />
      </Block>
      <Block id="question-block-answered">
        <QuestionBlock
          title={Q.question}
          fields={[field]}
          state={{
            kind: "answered",
            pairs: [[Q.question, H.decided.answered.answer]],
            who: H.decided.who,
          }}
        />
      </Block>
      <Block id="question-block-skipped">
        <QuestionBlock
          title={Q.question}
          fields={[field]}
          state={{ kind: "skipped", who: H.decided.who }}
        />
      </Block>
    </>
  );
}

function connectBlocks(): ReactNode {
  const X = H.connect;
  return (
    <>
      <Block id="connect-block-pending">
        <ConnectBlock service={X.service} reason={X.reason} note={X.note} onConnect={noop} />
      </Block>
      <Block id="connect-block-closed">
        <ConnectBlock
          service={H.decided.connected.service}
          reason={X.reason}
          closed={{ who: H.decided.who, when: H.decided.connected.at }}
        />
      </Block>
    </>
  );
}

function QueueBlock({
  id,
  state,
}: {
  id: string;
  state: "default" | "hover" | "editing" | "paused";
}) {
  const force =
    state === "hover"
      ? {
          pseudo: ["hover"] as ForcedPseudo[],
          selector:
            '[data-part="queued-message"]:nth-child(2) [data-part="queued-actions"] > [data-part="button"]',
        }
      : state === "editing"
        ? { pseudo: ["focus-within"] as ForcedPseudo[], selector: '[data-part="textarea"]' }
        : undefined;
  return (
    <Block id={id} {...(force ? { force } : {})}>
      <Stack gap={8}>
        <UserBubble text={CONV_FIXTURE.user.second} />
        {QUEUE_FIXTURE.map((m, i) => (
          <QueuedMessage
            key={m.text}
            text={m.text}
            editing={state === "editing" && i === 0}
            paused={state === "paused"}
            onCopy={noop}
            onEdit={noop}
            onSave={noop}
            onCancelEdit={noop}
            onDelete={noop}
            onSendNow={noop}
          />
        ))}
        {state === "paused" ? <QueuePaused count={QUEUE_FIXTURE.length} onContinue={noop} /> : null}
      </Stack>
    </Block>
  );
}

function queuedBlocks(): ReactNode {
  return (
    <>
      <QueueBlock id="queued-message-default" state="default" />
      <QueueBlock id="queued-message-hover" state="hover" />
      <QueueBlock id="queued-message-editing" state="editing" />
      <QueueBlock id="queued-message-paused" state="paused" />
    </>
  );
}

export const CONVERSATION_BLOCKS = {
  prose: proseBlocks,
  "thinking-row": thinkingRowBlocks,
  "user-bubble": userBubbleBlocks,
  "run-divider": runDividerBlocks,
  "tool-group": toolGroupBlocks,
  "tool-row": toolRowBlocks,
  "diff-block": diffBlockBlocks,
  "approval-block": approvalBlocks,
  "question-block": questionBlocks,
  "connect-block": connectBlocks,
  "queued-message": queuedBlocks,
} as const;
