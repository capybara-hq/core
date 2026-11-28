"use client";

import {
  ComposerEditor,
  ComposerFrame,
  type ComposerSegment,
  type ComposerTrigger,
} from "@capybara-hq/design";
import { COMPOSER_EDITOR_FIXTURE } from "@capybara-hq/design/fixtures";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Block } from "./conversation-blocks";
import { RefBlock, RefPending } from "./ref-block";

// The composer editor's blocks (composer inline tokens spec §1, §2, §6): the Lexical editor alone
// in the composer frame, one block per state. Each block is live: the interaction spec
// (visual/composer-editor.interaction.spec.ts) types into it and reads its hidden probe (the open
// trigger and the number of sends).

const T = COMPOSER_EDITOR_FIXTURE.tokens;

function EditorBlock({
  initial,
  hint,
  selectToken,
  form,
}: {
  initial: ComposerSegment[];
  hint?: string;
  /** Selects the first token as a click does (state `selected`). */
  selectToken?: boolean;
  form?: "medium" | "compact";
}) {
  const [segments, setSegments] = useState(initial);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [submits, setSubmits] = useState(0);
  const probe = useRef<HTMLSpanElement | null>(null);
  // `selected`: the token is clicked once Lexical has drawn it; the block stays pending until then,
  // so the specs (and the screenshots) never see it unselected
  const [selecting, setSelecting] = useState(selectToken === true);
  useEffect(() => {
    if (!selectToken) return;
    let frame = 0;
    const tick = () => {
      const token = probe.current?.parentElement?.querySelector<HTMLElement>(
        '[data-part="inline-token"]',
      );
      if (!token) {
        frame = requestAnimationFrame(tick);
        return;
      }
      token.click();
      if (token.getAttribute("data-selected") === "true") setSelecting(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [selectToken]);
  return (
    <ComposerFrame>
      <ComposerEditor
        segments={segments}
        onChange={setSegments}
        placeholder={COMPOSER_EDITOR_FIXTURE.placeholder}
        {...(hint ? { hint } : {})}
        onTrigger={setTrigger}
        onSubmit={() => setSubmits((n) => n + 1)}
        {...(form ? { referenceForm: form } : {})}
      />
      <span
        ref={probe}
        hidden
        data-probe="composer-editor"
        data-trigger={JSON.stringify(trigger)}
        data-submits={submits}
      />
      {selecting ? <RefPending /> : null}
    </ComposerFrame>
  );
}

const SENTENCE: ComposerSegment[] = [
  "把 ",
  T.file,
  " 的要点发到 ",
  T.slack,
  " 的 ",
  T.resource,
  "，参考 ",
  T.conversation,
  " 和 ",
  T.projectFile,
];

export function composerEditorBlocks(): ReactNode {
  return (
    <>
      <Block id="composer-editor-empty">
        <EditorBlock initial={[]} />
      </Block>
      <Block id="composer-editor-tokens">
        <EditorBlock initial={SENTENCE} />
      </Block>
      <Block id="composer-editor-selected">
        <EditorBlock initial={["给 ", T.slack, " 发消息"]} selectToken />
      </Block>
      <Block id="composer-editor-refused">
        <EditorBlock initial={["给 ", T.refused, " 发消息"]} />
      </Block>
      <Block id="composer-editor-skill">
        <EditorBlock initial={[T.skill, " "]} hint={COMPOSER_EDITOR_FIXTURE.hint} />
      </Block>
      <RefBlock id="composer-editor-compact" width={390} pad>
        <EditorBlock initial={SENTENCE} form="compact" />
      </RefBlock>
    </>
  );
}

export const COMPOSER_EDITOR_BLOCKS = { "composer-editor": composerEditorBlocks } as const;
