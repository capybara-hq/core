"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  Disclosure,
  KeyValue,
  OverviewSection,
  Stack,
  Subsection,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode, useContext } from "react";
import { SessionContext } from "../../../../components/shell/session";
import type {
  AdminHealth,
  AdminHealthQueue,
  AdminHealthReplica,
  ReplicaRole,
} from "../../../../lib/admin";
import { adminHealthQuery } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useErrorMessage } from "../../../../lib/use-error-message";

type T = ReturnType<typeof useTranslations<"admin.overview.health">>;

/** How often the section reads the health again while the page shows (spec §6.2). */
export const HEALTH_POLL_MS = 30_000;

const ROLES: ReplicaRole[] = ["api", "worker", "gateway"];

type QueueLabel =
  | "runs"
  | "subagentRuns"
  | "channels"
  | "maintenance"
  | "pluginScope"
  | "titles"
  | "usageReport"
  | "evals";

/** The readable name of each kernel queue (spec §6.2); an unknown queue shows its own name. */
const QUEUE_LABELS: Record<string, QueueLabel> = {
  "cap-kernel-runs": "runs",
  "cap-kernel-subagent-runs": "subagentRuns",
  "cap-kernel-channels": "channels",
  "cap-kernel-maintenance": "maintenance",
  "cap-kernel-plugin-scope": "pluginScope",
  "cap-kernel-titles": "titles",
  "cap-kernel-usage-report": "usageReport",
  "cap-kernel-evals": "evals",
};

/** Counts as the overview formats them (grouped digits in both locales, spec §8.2). */
const count = (n: number) => n.toLocaleString("en-US");

/**
 * 运行状况 (spec §6.2): one section with three groups. 内核: the version, the live replicas per role
 * (a role with none is a fail line saying what stops), a warn line when replicas report different
 * versions, and the replicas folded in a table. 队列: the kernel queues with readable names and
 * their counts, failures in the last day in fail. 连接: channel, device and sandbox counts. A
 * number the kernel could not read says 暂时无法读取 and the rest renders. Not prefetched: its own
 * skeleton on the first paint, then a read every 30 s while the page is visible (`poll`; off
 * only on the seeded /dev/ui page); when a later read fails the numbers stay, with a warn line
 * saying when they were read and 重试.
 */
export function HealthSection({ poll = true }: { poll?: boolean }) {
  const t = useTranslations("admin.overview.health");
  const errorMessage = useErrorMessage();
  const q = adminHealthQuery();
  const read = useQuery({
    ...q,
    retryOnMount: retryOnMountOf(q.queryKey),
    refetchInterval: poll ? HEALTH_POLL_MS : false,
    refetchIntervalInBackground: false,
  });
  const queueColumns = useQueueColumns(t);
  if (read.data === undefined) {
    return read.error ? (
      <OverviewSection
        title={t("title")}
        state="error"
        error={{
          summary: t("failed"),
          detail: errorMessage(read.error),
          onRetry: () => void read.refetch(),
        }}
      />
    ) : (
      <OverviewSection
        title={t("title")}
        state="loading"
        loading={[
          { kind: "key-value", rows: 2 },
          { kind: "table", label: t("groups.queues"), columns: queueColumns },
          { kind: "key-value", rows: 3 },
        ]}
      />
    );
  }
  const health = read.data;
  // A poll failed after an earlier answer: the numbers stay, saying how old they are.
  const stale = read.isRefetchError;
  return (
    <OverviewSection
      title={t("title")}
      state="ready"
      {...(stale && {
        actions: (
          <Button density="dense" onClick={() => void read.refetch()}>
            {t("retry")}
          </Button>
        ),
      })}
    >
      {stale ? (
        <Text tone="warn" icon="circle-alert">
          {t.rich("stale", {
            time: () => <DateTime value={new Date(read.dataUpdatedAt)} />,
          })}
        </Text>
      ) : null}
      <KernelGroup health={health} t={t} />
      <Subsection title={t("groups.queues")} variant="divided">
        {health.queues === null ? (
          <Unavailable t={t} />
        ) : (
          <DataTable<AdminHealthQueue>
            label={t("groups.queues")}
            rowHeight="dense"
            framed={false}
            columns={queueColumns}
            rows={health.queues}
            rowKey={(q) => q.name}
            state="ready"
          />
        )}
      </Subsection>
      <ConnectionsGroup health={health} t={t} />
    </OverviewSection>
  );
}

function useQueueColumns(t: T): Column<AdminHealthQueue>[] {
  const num = (key: "waiting" | "active" | "delayed") => ({
    key,
    header: t(`queueColumns.${key}`),
    align: "right" as const,
    fit: true,
    cell: (q: AdminHealthQueue) => count(q[key]),
  });
  return [
    {
      key: "name",
      header: t("queueColumns.name"),
      cell: (q) => {
        const label = QUEUE_LABELS[q.name];
        return label === undefined ? (
          <Text variant="body">{q.name}</Text>
        ) : (
          <Text variant="prose">{t(`queues.${label}`)}</Text>
        );
      },
    },
    num("waiting"),
    num("active"),
    num("delayed"),
    {
      key: "failedLastDay",
      header: t("queueColumns.failedLastDay"),
      align: "right",
      fit: true,
      cell: (q) =>
        q.failedLastDay > 0 ? (
          <Text tone="fail">{count(q.failedLastDay)}</Text>
        ) : (
          count(q.failedLastDay)
        ),
    },
  ];
}

const Unavailable = ({ t }: { t: T }) => <Text tone="muted">{t("unavailable")}</Text>;

/** Parts joined by ` · ` (or `sep`), as one key-value value. */
function joined(parts: ReactNode[], sep = " · "): ReactNode {
  return parts.map((p, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the parts are in a fixed order
    <Fragment key={i}>
      {i > 0 ? sep : null}
      {p}
    </Fragment>
  ));
}

/** `label n`, or `label 暂时无法读取` (muted) when the number could not be read. */
const part = (label: string, n: number | null, t: T): ReactNode => (
  <>
    {label} {n === null ? <Unavailable t={t} /> : count(n)}
  </>
);

function KernelGroup({ health, t }: { health: AdminHealth; t: T }) {
  const roles = health.roles;
  const replicas = health.replicas;
  const missing = roles === null ? [] : ROLES.filter((r) => roles[r] === 0);
  const mixed = replicas !== null && new Set(replicas.map((r) => r.version)).size > 1;
  const roleLine =
    roles === null ? (
      <Unavailable t={t} />
    ) : (
      joined(
        ROLES.map((r) => (
          <Fragment key={r}>
            {t(`roles.${r}`)}{" "}
            {roles[r] === 0 ? <Text tone="fail">{count(0)}</Text> : count(roles[r])}
          </Fragment>
        )),
      )
    );
  // The product version: the web app's (released in step with @capybara-hq/capybara), as the
  // status bar shows it
  const productVersion = useContext(SessionContext)?.version;
  return (
    <Subsection title={t("groups.kernel")} variant="divided">
      <Stack gap={8}>
        <KeyValue
          keyWidth="12ch"
          rows={[
            // The product version (`@capybara-hq/capybara`, released in step with this web app), then
            // the kernel package's own version, which only moves when the kernel changes
            ...(productVersion !== undefined
              ? [{ k: t("kernel.version"), v: productVersion }]
              : []),
            { k: t("kernel.kernelVersion"), v: versionLabel(health.kernel.version) },
            { k: t("kernel.replicas"), v: roleLine },
          ]}
        />
        {missing.map((r) => (
          <Text key={r} tone="fail" icon="circle-x">
            {t(`noReplicas.${r}`)}
          </Text>
        ))}
        {mixed ? (
          <Text tone="warn" icon="circle-alert">
            {t("kernel.mixedVersions")}
          </Text>
        ) : null}
        {replicas !== null && replicas.length > 0 ? (
          <Disclosure summary={t("kernel.replicaList", { n: replicas.length })}>
            <ReplicaTable replicas={replicas} t={t} />
          </Disclosure>
        ) : null}
      </Stack>
    </Subsection>
  );
}

function ReplicaTable({ replicas, t }: { replicas: AdminHealthReplica[]; t: T }) {
  const columns: Column<AdminHealthReplica>[] = [
    { key: "id", header: t("replicaColumns.id"), cell: (r) => r.id },
    {
      key: "roles",
      header: t("replicaColumns.roles"),
      cell: (r) => r.roles.join(" · "),
    },
    {
      key: "version",
      header: t("replicaColumns.version"),
      fit: true,
      cell: (r) => versionLabel(r.version),
    },
    {
      key: "startedAt",
      header: t("replicaColumns.startedAt"),
      tone: "muted",
      fit: true,
      cell: (r) => <DateTime value={r.startedAt} />,
    },
  ];
  return (
    <DataTable<AdminHealthReplica>
      label={t("kernel.replicas")}
      rowHeight="dense"
      framed={false}
      columns={columns}
      rows={replicas}
      rowKey={(r) => r.id}
      state="ready"
    />
  );
}

function ConnectionsGroup({ health, t }: { health: AdminHealth; t: T }) {
  const { channels, devices, sandboxes } = health;
  const c = (k: keyof typeof channels) => part(t(`channelParts.${k}`), channels[k], t);
  const rows: { k: ReactNode; v: ReactNode }[] = [
    {
      k: t("connections.channels"),
      v: joined([c("online"), c("offline"), c("webhook"), c("disabled"), c("error")]),
    },
    {
      k: t("connections.devices"),
      v: joined(
        [
          part(t("deviceParts.online"), devices.online, t),
          part(t("deviceParts.local"), devices.local, t),
        ],
        " / ",
      ),
    },
    {
      k: t("connections.sandboxes"),
      v:
        sandboxes === null ? (
          <Unavailable t={t} />
        ) : (
          joined([
            part(t("sandboxParts.running"), sandboxes.running, t),
            part(t("sandboxParts.suspended"), sandboxes.suspended, t),
          ])
        ),
    },
    ...(sandboxes !== null && sandboxes.byProvider.length > 0
      ? [
          {
            k: t("connections.byProvider"),
            v: sandboxes.byProvider.map((p) => `${p.provider} ${count(p.running)}`).join(" · "),
          },
        ]
      : []),
  ];
  return (
    <Subsection title={t("groups.connections")} variant="divided">
      <KeyValue keyWidth="12ch" rows={rows} />
    </Subsection>
  );
}
