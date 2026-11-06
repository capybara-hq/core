"use client";

import {
  type ActionRowProps,
  Card,
  type Column,
  DataTable,
  DateTime,
  InboxPage,
  KeyValue,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
  versionLabel,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import { type PlatformInboxItem, platformInboxHref } from "../../../../lib/admin-inbox";
import {
  displayNameOf,
  requesterOf,
  requestSubject,
  requestVersion,
} from "../../../../lib/catalog";
import { adminInboxQuery } from "../../../../lib/query/admin";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/admin/inbox`: what waits on the platform (InboxPage, spec §5.1 rule 5, §13.5): the orgs'
 * requests (`access` / `import`), plugins whose extension permissions wait for a confirmation,
 * failed scope syncs, and a platform components migration run that failed plugins or is stuck.
 * Nothing is decided here: the selected item's 前往处理 opens the page where it is acted on. From
 * the query cache (the layout prefetched the inbox on a first load).
 */
export default function AdminInboxView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminInboxRead />;
}

function AdminInboxRead() {
  const read = usePageQuery(adminInboxQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return <AdminInbox inbox={read.kind === "ready" ? read.data : null} />;
}

type Translate = ReturnType<typeof useTranslations>;

function AdminInbox({
  inbox,
}: {
  /** `null` while it loads. */
  inbox: { items: PlatformInboxItem[]; truncated: boolean } | null;
}) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.inbox");
  const locale = useLocale();
  const router = useRouter();
  const rows = inbox?.items ?? [];
  const [activeId, setActiveId] = useState<string>();
  const active = rows.find((i) => i.id === activeId) ?? rows[0];
  // Nothing while the inbox loads (not "0 pending")
  useStatusBar(inbox === null ? null : `· ${t("pendingCount", { n: rows.length })}`);

  const columns: Column<PlatformInboxItem>[] = [
    {
      key: "item",
      header: t("columns.item"),
      cell: (item) => (
        <Stack gap={0}>
          <Text>{titleOf(item, t, locale)}</Text>
          <Text variant="small" tone="muted">
            {subtitleOf(item, t)}
          </Text>
        </Stack>
      ),
    },
    {
      key: "at",
      header: t("columns.time"),
      tone: "muted",
      cell: (item) => <DateTime value={item.createdAt} />,
    },
  ];
  const open = (item: PlatformInboxItem): ActionRowProps => ({
    primary: { label: t("open"), onSelect: () => router.push(platformInboxHref(item)) },
  });
  const header = { path: [...scope, { label: "inbox" }], title: t("title") };

  if (inbox === null) {
    return (
      <InboxPage
        header={header}
        inspectorTitle={t("inspectorTitle")}
        actionRow={{ primary: { label: t("open"), onSelect: () => {} } }}
        loading={{
          list: "records",
          table: { label: t("listLabel"), columns, rowHeight: "dense", framed: false },
          inspector: { rows: 3, keyWidth: "10ch" },
        }}
      />
    );
  }
  const detail = active === undefined ? null : detailOf(active, t, locale);
  return (
    <InboxPage
      header={{
        ...header,
        description: t("description"),
        count: `${rows.length}${inbox.truncated ? "+" : ""}`,
      }}
      {...(rows.length === 0 ? { empty: { text: t("empty"), hint: t("emptyHint") } } : {})}
      list={
        <DataTable<PlatformInboxItem>
          label={t("listLabel")}
          rowHeight="dense"
          framed={false}
          columns={columns}
          rows={rows}
          rowKey={(i) => i.id}
          rowLabel={(i) => titleOf(i, t, locale)}
          {...(active ? { activeKey: active.id } : {})}
          onOpen={(i) => setActiveId(i.id)}
          state="ready"
          empty={{ title: t("empty"), hint: t("emptyHint") }}
        />
      }
      {...(active !== undefined && detail !== null
        ? {
            inspectorTitle: t("inspectorTitle"),
            inspector: detail.inspector,
            actionRow: open(active),
          }
        : {})}
    >
      <Stack gap={12}>
        {inbox.truncated && (
          <Text variant="small" tone="warn">
            {t("truncated")}
          </Text>
        )}
        {detail ? detail.content : rows.length > 0 ? <Text tone="muted">{t("pick")}</Text> : null}
      </Stack>
    </InboxPage>
  );
}

/** A row's title: the kind, then what it is about. */
function titleOf(item: PlatformInboxItem, t: Translate, locale: string): string {
  switch (item.type) {
    case "catalog_request":
      return `${t(`request.kind.${item.request.kind}`)} · ${displayNameOf(requestSubject(item.request), locale)}`;
    case "permission_confirmation":
      return `${t("permission.label")} · ${displayNameOf(item.item, locale)}`;
    case "scope_sync_failed":
      return `${t("sync.label")} · ${displayNameOf(item.failure.item, locale)}`;
    case "platform_migration":
      return t("migration.label");
  }
}

/** A row's second line: the org, the version, or what went wrong with the run. */
function subtitleOf(item: PlatformInboxItem, t: Translate): string {
  switch (item.type) {
    case "catalog_request":
      return item.request.orgName;
    case "permission_confirmation":
      return versionLabel(item.item.latestVersion);
    case "scope_sync_failed":
      return `${item.failure.org.name} · ${t(`sync.op.${item.failure.op}`)}`;
    case "platform_migration":
      return item.run.stuck
        ? t("migration.stuck")
        : t("migration.failed", { n: item.run.itemsFailed.length });
  }
}

/** The selected item: the content card and the inspector's facts. */
function detailOf(
  item: PlatformInboxItem,
  t: Translate,
  locale: string,
): { content: ReactNode; inspector: ReactNode } {
  switch (item.type) {
    case "catalog_request": {
      const r = item.request;
      const version = requestVersion(r);
      return {
        inspector: (
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("org"), v: r.orgName },
              { k: t("request.requester"), v: requesterOf(r) },
              { k: t("request.version"), v: version === null ? "—" : versionLabel(version) },
              { k: t("time"), v: <DateTime value={r.createdAt} /> },
            ]}
          />
        ),
        content: (
          <Card
            title={titleOf(item, t, locale)}
            actions={<StatusMark status="waiting" label={t("waiting")} />}
          >
            <Stack gap={8}>
              {r.note !== "" && (
                <Stack gap={4}>
                  <Text variant="small" tone="muted">
                    {t("request.note")}
                  </Text>
                  <Text variant="prose">{r.note}</Text>
                </Stack>
              )}
              <Text variant="prose">{t(`request.hint.${r.kind}`, { org: r.orgName })}</Text>
            </Stack>
          </Card>
        ),
      };
    }
    case "permission_confirmation": {
      const i = item.item;
      return {
        inspector: (
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("plugin"), v: i.name },
              { k: t("permission.version"), v: versionLabel(i.latestVersion) },
            ]}
          />
        ),
        content: (
          <Card
            title={titleOf(item, t, locale)}
            actions={<StatusMark status="waiting" label={t("waiting")} />}
          >
            <Text variant="prose">
              {i.builtin ? t("permission.hintBuiltin") : t("permission.hint")}
            </Text>
          </Card>
        ),
      };
    }
    case "scope_sync_failed": {
      const f = item.failure;
      return {
        inspector: (
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("plugin"), v: f.item.name },
              { k: t("org"), v: f.org.name },
              { k: t("sync.code"), v: f.code },
              { k: t("time"), v: <DateTime value={f.failedAt} /> },
            ]}
          />
        ),
        content: (
          <Card
            title={titleOf(item, t, locale)}
            actions={<StatusMark status="failed" label={t("failed")} />}
          >
            <Stack gap={8}>
              <Text variant="prose">{t(`sync.hint.${f.op}`, { org: f.org.name })}</Text>
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {t("sync.message")}
                </Text>
                <Text variant="prose">{f.message}</Text>
              </Stack>
            </Stack>
          </Card>
        ),
      };
    }
    case "platform_migration": {
      const run = item.run;
      return {
        inspector: (
          <KeyValue
            keyWidth="10ch"
            rows={[
              { k: t("migration.started"), v: <DateTime value={run.startedAt} /> },
              {
                k: t("migration.finished"),
                v: run.finishedAt === null ? "—" : <DateTime value={run.finishedAt} />,
              },
            ]}
          />
        ),
        content: (
          <Card
            title={titleOf(item, t, locale)}
            actions={
              <StatusMark status="failed" label={run.stuck ? t("migration.stuck") : t("failed")} />
            }
          >
            <Stack gap={8}>
              <Text variant="prose">
                {run.stuck ? t("migration.hintStuck") : t("migration.hintFailed")}
              </Text>
              {run.itemsFailed.length > 0 && (
                <Stack gap={4}>
                  <Text variant="small" tone="muted">
                    {t("migration.items")}
                  </Text>
                  <Text variant="prose">{run.itemsFailed.join(", ")}</Text>
                </Stack>
              )}
            </Stack>
          </Card>
        ),
      };
    }
  }
}
