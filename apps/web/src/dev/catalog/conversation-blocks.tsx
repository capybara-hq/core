"use client";

import {
  BubbleAttachments,
  Prose,
  RunDivider,
  Stack,
  ThinkingRow,
  UserBubble,
} from "@capybara-hq/design";
import {
  CONV_FIXTURE,
  DIVIDER_FIXTURE,
  FILE_FIXTURE,
  PROSE_FIXTURE,
} from "@capybara-hq/design/fixtures";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// The conversation-page blocks of the reference set (docs/design/reference/src/conversation.js):
// one RefBlock per state, 752 wide with the reference's padding, the content in a chat column.

const W = 752;
const noop = () => {};

function Block({ id, children }: { id: string; children: ReactNode }) {
  return (
    <RefBlock id={id} width={W} pad>
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

export const CONVERSATION_BLOCKS = {
  prose: proseBlocks,
  "thinking-row": thinkingRowBlocks,
  "user-bubble": userBubbleBlocks,
  "run-divider": runDividerBlocks,
} as const;
