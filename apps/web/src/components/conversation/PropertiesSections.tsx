"use client";

import {
  ContextSection as ContextBlock,
  FilesSection as FilesBlock,
  formatBytes,
  PropertiesPanel,
  typeBadge,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
import { getSandboxStatus } from "../../lib/artifacts";
import { listConnectors } from "../../lib/connectors";
import type { ConversationEvent, ModelRef } from "../../lib/conversations";
import type { FileOutput } from "../../lib/files";
import type { UiContributionItem } from "../../lib/ui";
import { useLoad } from "../../lib/use-load";
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
 */
export function ContextSection({
  orgId,
  conversationId,
  events,
  model,
  contextPct,
}: {
  orgId: string;
  conversationId: string;
  events: readonly ConversationEvent[];
  model: ModelRef | null;
  contextPct: number | null;
}) {
  const t = useTranslations("chatPanel");
  const connectors = useLoad(() => listConnectors(orgId), [orgId]);
  const nameOfSlug = useMemo(
    () =>
      new Map(
        connectors.state.kind === "ready"
          ? connectors.state.data.connectors.map((a) => [a.slug, a.name])
          : [],
      ),
    [connectors.state],
  );
  const sandbox = useLoad(() => getSandboxStatus(orgId, conversationId), [orgId, conversationId]);
  const uses = sandboxUses(events);
  const seen = useRef(uses);
  const { reload } = sandbox;
  useEffect(() => {
    if (uses === seen.current) return;
    seen.current = uses;
    reload();
  }, [uses, reload]);
  const s = sandbox.state;
  const sandboxText =
    s.kind === "loading"
      ? undefined
      : s.kind === "error"
        ? t("sandboxFailed")
        : s.data === null
          ? t("sandboxNone")
          : t(s.data.status === "running" ? "sandboxRunning" : "sandboxSuspended");
  return (
    <ContextBlock
      ratio={contextPct ?? 0}
      model={model === null ? "—" : model.model}
      {...(sandboxText !== undefined ? { sandbox: `${t("sandbox")} ${sandboxText}` } : {})}
      connectors={connectorsUsed(events, nameOfSlug)}
    />
  );
}

/** The built-in Files section: the conversation's file outputs; a row opens the file panel. */
export function FilesSection({ files, onOpen }: { files: FileOutput[]; onOpen(id: string): void }) {
  return (
    <FilesBlock
      files={files.map((f) => ({
        id: f.id,
        name: f.name,
        badge: typeBadge(f.name, f.contentType),
        size: formatBytes(f.size),
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
 * The properties panel (spec §5.3): Context, Files (when there are any), Background tasks (Task 21,
 * hidden until there is a sub-agent), then the extensions' sections in contribution order, each
 * failing alone.
 */
export function PropertiesSections({
  ctx,
  events,
  model,
  contextPct,
  files,
  sections,
  onOpenFile,
}: {
  ctx: BlockContext;
  events: readonly ConversationEvent[];
  model: ModelRef | null;
  contextPct: number | null;
  files: FileOutput[];
  sections: UiContributionItem[];
  onOpenFile(id: string): void;
}) {
  return (
    <PropertiesPanel>
      <ContextSection
        orgId={ctx.orgId}
        conversationId={ctx.conversationId}
        events={events}
        model={model}
        contextPct={contextPct}
      />
      {files.length > 0 ? <FilesSection files={files} onOpen={onOpenFile} /> : null}
      {sections.map((c) => (
        <ExtensionSection key={`${c.plugin}/${c.id}`} ctx={ctx} c={c} />
      ))}
    </PropertiesPanel>
  );
}
