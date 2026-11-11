"use client";

import {
  ContextSection as ContextBlock,
  FilesSection as FilesBlock,
  formatBytes,
  formatDateTime,
  ItemList,
  PropertiesPanel,
  PropertySection,
  typeBadge,
  useTimeZone,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useContext, useEffect, useMemo, useRef } from "react";
import type {
  BackgroundTaskView,
  ConversationEvent,
  ModelRef,
  SubagentView,
  ToolInfo,
} from "../../lib/conversations";
import { deviceState } from "../../lib/devices";
import type { FileOutput } from "../../lib/files";
import { myRole, roleAtLeast } from "../../lib/members";
import { retryOnMountOf } from "../../lib/query/client";
import {
  connectorsQuery,
  conversationDeviceQuery,
  conversationQuery,
} from "../../lib/query/conversation";
import { conversationSchedulesQuery } from "../../lib/query/schedules";
import { scheduleState } from "../../lib/schedules";
import { useToolInfo } from "../../lib/tool-info";
import { parseToolKey } from "../../lib/tool-key";
import type { UiOpen } from "../../lib/ui";
import { ExtensionSlot } from "../extension-ui/ExtensionSlot";
import { SessionContext } from "../shell/session";
import { useDeviceName } from "../use-device-name";
import { BackgroundSection } from "./BackgroundSection";

/** A connector tool's key is `mcp__<connector slug>__<tool>`. */
const slugOf = (toolKey: string): string | null => {
  const parsed = parseToolKey(toolKey);
  return parsed?.kind === "connector" ? parsed.slug : null;
};

/**
 * The connectors this conversation used, in first-use order: tool calls matched to connector slugs,
 * plus message attachments and connect requests (payload fields still named `appName`). Only the
 * loaded part of the log counts (history paging spec §5: no server summary; it grows as earlier
 * pages load).
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

/**
 * The newest sandbox tool result's seq (0 without one), or null while the metadata of any result
 * key is still unknown (so it never jumps when it arrives). A seq, not a count: earlier pages of
 * the log loaded later (history paging spec §5) are no new use.
 */
const sandboxUses = (
  events: readonly ConversationEvent[],
  info: ReadonlyMap<string, ToolInfo>,
): number | null => {
  let n = 0;
  for (const e of events) {
    if (e.type !== "tool_result") continue;
    const i = info.get(e.payload.toolKey);
    if (i === undefined) return null;
    if (i.sandbox) n = e.seq;
  }
  return n;
};

/**
 * Reads the conversation's device again whenever the number of sandbox tool results changes:
 * a result may have started, stopped or suspended the instance. It lives in the conversation page,
 * which is mounted from the start, not in the properties panel: a panel opened after the tools ran
 * would take the current count as its baseline and keep showing a fresh but outdated state.
 */
export function useDeviceRefresh(
  orgId: string,
  conversationId: string,
  events: readonly ConversationEvent[],
): void {
  const qc = useQueryClient();
  const resultKeys = useMemo(
    () => [
      ...new Set(events.flatMap((e) => (e.type === "tool_result" ? [e.payload.toolKey] : []))),
    ],
    [events],
  );
  const info = useToolInfo(orgId, conversationId, resultKeys);
  const uses = useMemo(() => sandboxUses(events, info), [events, info]);
  const seenUses = useRef<number | null>(null);
  useEffect(() => {
    if (uses === null) return;
    const prev = seenUses.current;
    seenUses.current = uses;
    // The first resolved count is the baseline, not a change.
    if (prev !== null && uses !== prev)
      void qc.invalidateQueries({
        queryKey: conversationDeviceQuery(orgId, conversationId).queryKey,
      });
  }, [uses, qc, orgId, conversationId]);
}

/**
 * The built-in Context section (the old Context tab): the context ratio of the latest step's usage,
 * the model, the device and its state (kept current by {@link useDeviceRefresh}) and the
 * connectors used.
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
  const connectorsQ = connectorsQuery(orgId);
  const connectors = useQuery({
    ...connectorsQ,
    retryOnMount: retryOnMountOf(connectorsQ.queryKey),
  }).data;
  const nameOfSlug = useMemo(
    () => new Map((connectors?.connectors ?? []).map((a) => [a.slug, a.name])),
    [connectors],
  );
  const te = useTranslations("devices");
  const nameOf = useDeviceName();
  const rowQ = conversationQuery(orgId, conversationId);
  const deviceId = useQuery({ ...rowQ, retryOnMount: retryOnMountOf(rowQ.queryKey) }).data
    ?.deviceId;
  const deviceQ = conversationDeviceQuery(orgId, conversationId);
  const device = useQuery({
    ...deviceQ,
    retryOnMount: retryOnMountOf(deviceQ.queryKey),
  });
  // The route answers null both for "none bound" and "the bound one was deleted": the
  // conversation's own deviceId tells them apart.
  const deviceText =
    device.data === undefined
      ? device.error === null
        ? undefined
        : t("deviceFailed")
      : device.data === null
        ? deviceId
          ? t("deviceDeleted")
          : t("deviceNone")
        : t("deviceLine", {
            name: nameOf(device.data),
            state: te(`state.${deviceState(device.data)}`),
          });
  return (
    <ContextBlock
      ratio={contextPct ?? 0}
      model={model === null ? "—" : model.model}
      {...(deviceText !== undefined ? { sandbox: deviceText } : {})}
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
 * The properties panel (spec §6.16.17 order): Context, Files (when there are any, the sub-agents'
 * deliveries included), then Background tasks (hidden until there is a background task or a
 * sub-agent); the extensions' sections (slot `conversation.properties.section`, each failing alone)
 * follow the anchor they name, `context`, `files` or `background`, in the kernel's order.
 */
export function PropertiesSections({
  orgId,
  conversationId,
  onOpenTarget,
  events,
  model,
  contextPct,
  lastRun,
  files,
  onOpenFile,
  background,
  total,
}: {
  orgId: string;
  conversationId: string;
  /** Opens an open target of an extension section: a panel of the same extension. */
  onOpenTarget(plugin: string, target: UiOpen): void;
  events: readonly ConversationEvent[];
  model: ModelRef | null;
  contextPct: number | null;
  lastRun?: string | undefined;
  files: FileOutput[];
  onOpenFile(id: string): void;
  background?:
    | {
        views: readonly SubagentView[];
        tasks: readonly BackgroundTaskView[];
        stopping: ReadonlySet<string>;
        onStop(item: { kind: "task" | "subagent"; id: string }): void;
        onOpen(item: { kind: "task" | "subagent"; id: string }): void;
      }
    | undefined;
  total?: string | undefined;
}) {
  const after = (anchor: string) => (
    <ExtensionSlot
      slot="conversation.properties.section"
      args={{ orgId, conversationId }}
      anchor={anchor}
      host={{ onOpenTarget }}
    />
  );
  return (
    <PropertiesPanel>
      <ContextSection
        orgId={orgId}
        conversationId={conversationId}
        events={events}
        model={model}
        contextPct={contextPct}
        lastRun={lastRun}
        total={total}
      />
      {after("context")}
      {files.length > 0 ? <FilesSection files={files} onOpen={onOpenFile} /> : null}
      {after("files")}
      {background && background.views.length + background.tasks.length > 0 ? (
        <BackgroundSection
          views={background.views}
          tasks={background.tasks}
          stopping={background.stopping}
          onStop={background.onStop}
          onOpen={background.onOpen}
        />
      ) : null}
      {after("background")}
      <SchedulesSection orgId={orgId} conversationId={conversationId} />
    </PropertiesPanel>
  );
}

/**
 * My scheduled tasks that post into this conversation (a `conversation` task, or a `chat` task of
 * the chat it belongs to; scheduled tasks spec §10): each task's name, linking to it, and its next
 * run. Shown only when there is one; members up (a guest has no tasks).
 */
export function SchedulesSection({
  orgId,
  conversationId,
}: {
  orgId: string;
  conversationId: string;
}) {
  const t = useTranslations("schedules");
  const timeZone = useTimeZone();
  const me = useContext(SessionContext)?.me;
  const member = me !== undefined && roleAtLeast(myRole(me), "member");
  const q = conversationSchedulesQuery(orgId, conversationId);
  const items = useQuery({ ...q, enabled: member, retryOnMount: retryOnMountOf(q.queryKey) }).data
    ?.items;
  if (items === undefined || items.length === 0) return null;
  return (
    <PropertySection title={t("panelTitle")} value={String(items.length)}>
      <ItemList
        label={t("panelTitle")}
        rows={items.map((task) => ({
          id: task.id,
          title: task.name,
          href: `/schedules/${encodeURIComponent(task.id)}`,
          meta:
            task.nextRunAt === null
              ? t(`state.${scheduleState(task)}`)
              : t("nextRunAt", { at: formatDateTime(task.nextRunAt, "full", timeZone) }),
        }))}
      />
    </PropertySection>
  );
}
