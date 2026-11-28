"use client";

import {
  Badge,
  Button,
  CellTitle,
  type Column,
  DateTime,
  Dialog,
  Stack,
  StatusMark,
  Text,
  TextLink,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ComponentProps, useState } from "react";
import {
  type Automation,
  type AutomationListItem,
  type AutomationOrigin,
  type AutomationTrigger,
  automationState,
  automationWords,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
  runAutomation,
  type TriggerInput,
  zoneOf,
} from "../lib/automations";
import { extensionLabel, labelLocale } from "../lib/extension-label";
import { eventSourcesQuery } from "../lib/query/automations";
import { retryOnMountOf } from "../lib/query/client";
import { inboxChangeKeys } from "../lib/query/inbox";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** A schedule in words, with its zone when given ("Every day at 09:00 (Asia/Shanghai)"). */
export function useAutomationWords(): (
  trigger: AutomationTrigger | TriggerInput,
  zone?: string,
) => string {
  const t = useTranslations("automations");
  return (trigger, zone) => {
    const w = automationWords(trigger);
    const values =
      w.key === "weekly"
        ? { ...w.values, day: t(`weekday.${w.values.day}` as "weekday.0") }
        : w.values;
    const when = t(`when.${w.key}`, values);
    return zone === undefined ? when : t("withZone", { when, zone });
  };
}

/**
 * A trigger source's display name for the task lists (the extension name while it cannot be
 * read). The event sources are read only when one of `tasks` is an acceptance automation.
 */
export function useEventSourceName(
  orgId: string,
  tasks: readonly Pick<Automation, "origin">[] | null | undefined,
): (source: string) => string {
  const locale = labelLocale(useLocale());
  const q = eventSourcesQuery(orgId);
  const sources = useQuery({
    ...q,
    retryOnMount: retryOnMountOf(q.queryKey),
    enabled: (tasks ?? []).some((t) => t.origin === "acceptance"),
  }).data;
  return (source) => {
    const s = sources?.items.find((i) => i.source === source);
    return s === undefined
      ? source
      : extensionLabel({ name: s.source, displayName: s.name }, locale);
  };
}

/** The status mark of a task: its state, or why it is paused. */
export function AutomationStateMark({
  task,
}: {
  task: Pick<Automation, "status" | "pauseReason">;
}) {
  const t = useTranslations("automations.state");
  const state = automationState(task);
  const status: ComponentProps<typeof StatusMark>["status"] =
    state === "active"
      ? "success"
      : state === "ended" || state === "paused.expired"
        ? "cancelled"
        : state === "paused.creator" || state === "paused.admin"
          ? "waiting"
          : "failed";
  return <StatusMark status={status} label={t(state)} />;
}

/**
 * A task's actions (pause, resume, run, delete): each invalidates the task lists, the task and,
 * since the creator's inbox derives attention from the task, the inbox.
 */
export function useAutomationActions(orgId: string) {
  const touched = (id: string) => [
    keys.org(orgId).automationsAll(),
    keys.org(orgId).automation(id),
    ...inboxChangeKeys(orgId),
  ];
  const pause = useAppMutation({
    fn: (id: string) => pauseAutomation(orgId, id),
    invalidates: (id) => touched(id),
  });
  const resume = useAppMutation({
    fn: (id: string) => resumeAutomation(orgId, id),
    invalidates: (id) => touched(id),
  });
  const run = useAppMutation({
    fn: (v: { id: string; trial: boolean }) => runAutomation(orgId, v.id, v.trial),
    invalidates: (v) => [keys.org(orgId).automationRuns(v.id), keys.org(orgId).automationsAll()],
  });
  const remove = useAppMutation({
    fn: (id: string) => deleteAutomation(orgId, id),
    invalidates: () => [keys.org(orgId).automationsAll(), ...inboxChangeKeys(orgId)],
    forgetsOnLeave: (id) => [keys.org(orgId).automation(id)],
  });
  return { pause, resume, run, remove };
}

/**
 * Delete a task: asks first (a dangerous dialog that starts on Cancel). An acceptance automation
 * (`origin: acceptance`) is made again by the next assigned work while the person's rule for its
 * source is `auto`: the dialog says so and links to the rules (the sheet of `/automations?rules=1`).
 */
export function DeleteAutomationDialog({
  name,
  origin,
  onClose,
  onDelete,
}: {
  name: string;
  origin: AutomationOrigin;
  onClose(): void;
  onDelete(): Promise<void>;
}) {
  const t = useTranslations("automations.actions");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onDelete();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t("deleteConfirm", { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {tc("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("delete")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("deleteConfirmBody")}</Text>
        {origin === "acceptance" && (
          <Text variant="prose">
            {t("deleteAcceptanceBody")}{" "}
            <TextLink href="/automations?rules=1">{t("deleteAcceptanceLink")}</TextLink>
          </Text>
        )}
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

/** The keys of the task table's columns (the compact layout maps are typed against them). */
export type AutomationColumnKey = "name" | "agent" | "schedule" | "status" | "next" | "last";

type AutomationT = ReturnType<typeof useTranslations<"automations">>;

/** A task table's columns (the loading table draws the same header). */
export function automationColumns(
  t: AutomationT,
  when: ReturnType<typeof useAutomationWords>,
  agentName: (id: string) => string,
  /** A trigger source's display name (an acceptance automation names the source it serves). */
  sourceName: (source: string) => string = (s) => s,
): (Column<AutomationListItem> & { key: AutomationColumnKey })[] {
  return [
    {
      key: "name",
      header: t("columns.name"),
      // an acceptance automation carries the 接收规则 tag and says which source's work it
      // accepts (collaboration spec §4.4)
      cell: (s) =>
        s.origin === "acceptance" ? (
          <Stack direction="row" gap={8} align="center">
            <CellTitle
              title={s.name}
              {...(s.trigger.kind === "event"
                ? { description: t("acceptsWork", { source: sourceName(s.trigger.source) }) }
                : {})}
            />
            <Badge>{t("acceptanceTag")}</Badge>
          </Stack>
        ) : (
          <CellTitle title={s.name} />
        ),
    },
    { key: "agent", header: t("columns.agent"), cell: (s) => agentName(s.agentId) },
    {
      key: "schedule",
      header: t("columns.schedule"),
      tone: "muted",
      cell: (s) => when(s.trigger, zoneOf(s.trigger) ?? undefined),
    },
    { key: "status", header: t("columns.status"), cell: (s) => <AutomationStateMark task={s} /> },
    {
      key: "next",
      header: t("columns.nextRun"),
      tone: "muted",
      fit: true,
      cell: (s) => (s.nextRunAt === null ? "—" : <DateTime value={s.nextRunAt} />),
    },
    {
      key: "last",
      header: t("columns.lastResult"),
      fit: true,
      cell: (s) => {
        const r = s.lastRun;
        if (r === null) return <Text tone="muted">{t("noResult")}</Text>;
        const label =
          r.status === "skipped" && r.skipReason !== null
            ? t(`runs.skip.${r.skipReason}`)
            : t(`runs.status.${r.status}`);
        const failed =
          r.status === "failed" && s.consecutiveFailures > 1
            ? t("failedInARow", { n: s.consecutiveFailures })
            : label;
        return (
          <StatusMark
            status={
              r.status === "completed" ? "success" : r.status === "failed" ? "failed" : "cancelled"
            }
            label={failed}
          />
        );
      },
    },
  ];
}
