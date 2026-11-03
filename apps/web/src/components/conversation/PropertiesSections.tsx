"use client";

import {
  ContextSection as ContextBlock,
  FilesSection as FilesBlock,
  formatBytes,
  PropertiesPanel,
  typeBadge,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
import type { ConversationEvent, ModelRef, SubagentView } from "../../lib/conversations";
import type { FileOutput } from "../../lib/files";
import { retryOnMountOf } from "../../lib/query/client";
import { connectorsQuery, sandboxQuery } from "../../lib/query/conversation";
import type { UiContributionItem } from "../../lib/ui";
import { BackgroundSection } from "./BackgroundSection";
import { type BlockContext, ExtensionSection } from "./ExtensionBlocks";

/** A connector tool's key is `<connector slug>__<tool>`. */
const slugOf = (toolKey: string): string | null => {
  const i = toolKey.indexOf("__");
  return i > 0 ? toolKey.slice(0, i) : null;
};

/**
 * The connectors this conversation used, in first-use order: tool calls matched to connector slugs,
 * plus message attachments and connect requests (payload fields still named `appName`).
 */
export function connectorsUsed(
  events: readonly ConversationEvent[],
  nameOfSlug: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  const add = (name: string | undefined) => {
    if (name !== undefined && name !== "" && !out.includes(name)) out.push(name);
  };
  for (const e of events) {
    if (e.type === "assistant_message") {
      for (const b of e.payload.content) {
        if (b.type === "tool_call") {
          const slug = slugOf(b.name);
          if (slug !== null) add(nameOfSlug.get(slug));
        }
      }
    } else if (e.type === "user_message") {
      for (const a of e.payload.attachments ?? []) add(a.appName);
    } else if (e.type === "connection_required") {
      add(e.payload.appName);
    }
  }
  return out;
}

const sandboxUses = (events: readonly ConversationEvent[]): number =>
  events.filter((e) => e.type === "tool_result" && e.payload.toolKey.startsWith("sandbox_")).length;

/**
 * The built-in Context section (the old Context tab): the context ratio of the latest step's usage,
 * the model, the sandbox state (read again after each sandbox tool result) and the connectors used.
 * A connectors read the role is refused (R5: not read again on mount) names no connectors.
 */
export function ContextSection({
  orgId,
  conversationId,
  events,
  model,
  contextPct,
  lastRun,
  total,
}: {
  orgId: string;
  conversationId: string;
  events: readonly ConversationEvent[];
  model: ModelRef | null;
  contextPct: number | null;
  /** The last run's line, once a run ended. */
  lastRun?: string | undefined;
  /** The tokens with sub-agents line, once there are any. */
  total?: string | undefined;
}) {
  const t = useTranslations("chatPanel");
  const qc = useQueryClient();
  const connectorsQ = connectorsQuery(orgId);
  const connectors = useQuery({
    ...connectorsQ,
    retryOnMount: retryOnMountOf(connectorsQ.queryKey),
  }).data;
  const nameOfSlug = useMemo(
    () => new Map((connectors?.connectors ?? []).map((a) => [a.slug, a.name])),
    [connectors],
  );
  const sandboxQ = sandboxQuery(orgId, conversationId);
  const sandbox = useQuery({ ...sandboxQ, retryOnMount: retryOnMountOf(sandboxQ.queryKey) });
  const uses = useMemo(() => sandboxUses(events), [events]);
  // A sandbox tool result since the last look may have started, stopped or replaced it.
  const seenUses = useRef(uses);
  useEffect(() => {
    if (uses === seenUses.current) return;
    seenUses.current = uses;
    void qc.invalidateQueries({ queryKey: sandboxQ.queryKey });
  }, [uses, qc, sandboxQ.queryKey]);
  const sandboxText =
    sandbox.data === undefined
      ? sandbox.error === null
        ? undefined
        : t("sandboxFailed")
      : sandbox.data === null
        ? t("sandboxNone")
        : t(sandbox.data.status === "running" ? "sandboxRunning" : "sandboxSuspended");
  return (
    <ContextBlock
      ratio={contextPct ?? 0}
      model={model === null ? "—" : model.model}
      {...(sandboxText !== undefined ? { sandbox: `${t("sandbox")} ${sandboxText}` } : {})}
      connectors={connectorsUsed(events, nameOfSlug)}
      {...(lastRun !== undefined ? { lastRun } : {})}
      {...(total !== undefined ? { total } : {})}
    />
  );
}

/**
 * The built-in Files section: the conversation's file outputs and its sub-agents' deliveries (marked
 * "from <sub-agent>"); a row opens the file panel.
 */
export function FilesSection({ files, onOpen }: { files: FileOutput[]; onOpen(id: string): void }) {
  return (
    <FilesBlock
      files={files.map((f) => ({
        id: f.id,
        name: f.name,
        badge: typeBadge(f.name, f.contentType),
        size: formatBytes(f.size),
        ...(f.from ? { from: f.from.name } : {}),
      }))}
      onOpen={onOpen}
      onAll={() => {
        const first = files[0];
        if (first) onOpen(first.id);
      }}
    />
  );
}

/**
 * The properties panel (spec §6.16.17 order): Context, the extensions' sections in contribution
 * order (each failing alone), Files (when there are any, the sub-agents' deliveries included), then
 * Background tasks (hidden until there is a sub-agent).
 */
export function PropertiesSections({
  ctx,
  events,
  model,
  contextPct,
  lastRun,
  files,
  sections,
  onOpenFile,
  subagents,
  total,
}: {
  ctx: BlockContext;
  events: readonly ConversationEvent[];
  model: ModelRef | null;
  contextPct: number | null;
  lastRun?: string | undefined;
  files: FileOutput[];
  sections: UiContributionItem[];
  onOpenFile(id: string): void;
  subagents?:
    | { views: readonly SubagentView[]; onStop(id: string): void; onOpen(id: string): void }
    | undefined;
  total?: string | undefined;
}) {
  return (
    <PropertiesPanel>
      <ContextSection
        orgId={ctx.orgId}
        conversationId={ctx.conversationId}
        events={events}
        model={model}
        contextPct={contextPct}
        lastRun={lastRun}
        total={total}
      />
      {sections.map((c) => (
        <ExtensionSection key={`${c.plugin}/${c.id}`} ctx={ctx} c={c} />
      ))}
      {files.length > 0 ? <FilesSection files={files} onOpen={onOpenFile} /> : null}
      {subagents && subagents.views.length > 0 ? (
        <BackgroundSection
          views={subagents.views}
          onStop={subagents.onStop}
          onOpen={subagents.onOpen}
        />
      ) : null}
    </PropertiesPanel>
  );
}
