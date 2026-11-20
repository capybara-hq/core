"use client";

import {
  type ActionRowProps,
  DateTime,
  formatDateTime,
  InboxPage,
  LinkButton,
  type ListDetailFact,
  ListDetailList,
  Stack,
  StatusMark,
  Text,
  useStatusBar,
  useTimeZone,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import { useRouter } from "../../../../i18n/navigation";
import {
  dismissPlatformNotice,
  type PlatformInboxItem,
  type PlatformInboxType,
  type PlatformInboxView,
  type PlatformNotice,
  platformInboxHref,
} from "../../../../lib/admin-inbox";
import {
  displayNameOf,
  ownerOrgOf,
  requesterOf,
  requestSubject,
  requestVersion,
} from "../../../../lib/catalog";
import { useHashItem } from "../../../../lib/hash-item";
import { adminInboxQuery } from "../../../../lib/query/admin";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/admin/inbox`: what waits on the platform (InboxPage, spec §5.1 rule 5, §13.5): the orgs'
 * requests (`access` / `import`), plugins whose extension permissions wait for a confirmation,
 * failed scope syncs, org uploads waiting in 待确认 and shared items now owned by the platform
 * (phase 3). Nothing is decided here: the selected item's 前往处理 opens the page where it is acted on; a transfer is a
 * notice, which 知道了 dismisses for every super admin. `type` (the overview's per-type rows,
 * `?type=`) lists only that type, filtered on the cached list, with a link back to all. From
 * the query cache (the layout prefetched the inbox on a first load).
 */
export default function AdminInboxView({ type = null }: { type?: PlatformInboxType | null }) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminInboxRead type={type} />;
}

function AdminInboxRead({ type }: { type: PlatformInboxType | null }) {
  const read = usePageQuery(adminInboxQuery());
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return <AdminInbox inbox={read.kind === "ready" ? read.data : null} type={type} />;
}

type Translate = ReturnType<typeof useTranslations>;

function AdminInbox({
  inbox,
  type,
}: {
  /** `null` while it loads. */
  inbox: PlatformInboxView | null;
  /** Only this type is listed (null: all). */
  type: PlatformInboxType | null;
}) {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.inbox");
  const tt = useTranslations("admin.overview.attention");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const rows = useMemo(
    () => (inbox?.items ?? []).filter((i) => type === null || i.type === type),
    [inbox, type],
  );
  const [activeId, setActiveId] = useState<string>();
  // The two-level stack (spec §6.47): the list is the page until an item is opened; the open item
  // is in the URL hash, so the system back closes it and `#item=<id>` deep-links.
  const hashItem = useHashItem();
  const active = rows.find((i) => i.id === (hashItem.id ?? activeId)) ?? rows[0];
  // Nothing while the inbox loads (not "0 pending")
  // The total, not the shown rows: the list stops at 100
  useStatusBar(inbox === null ? null : `· ${t("pendingCount", { n: inbox.total })}`);

  const timeZone = useTimeZone();
  // Dismissing a platform notice changes the inbox, its count and the overview's total
  const dismiss = useAppMutation({
    fn: (id: string) => dismissPlatformNotice(id),
    invalidates: () => [
      keys.deployment().adminInbox(),
      keys.deployment().adminInboxCount(),
      keys.deployment().adminOverview(),
    ],
  });
  const open = (item: PlatformInboxItem): ActionRowProps =>
    item.type === "ownership_transferred"
      ? {
          secondary: {
            label: t("transferred.view"),
            onSelect: () => router.push(platformInboxHref(item)),
          },
          primary: {
            label: t("transferred.dismiss"),
            loading: dismiss.isPending,
            disabled: dismiss.isPending,
            onSelect: () =>
              void dismiss.mutateAsync(item.id).then(
                () => toast.success(t("transferred.dismissed")),
                (e: unknown) => toast.error(errorMessage(e)),
              ),
          },
        }
      : { primary: { label: t("open"), onSelect: () => router.push(platformInboxHref(item)) } };
  const header = { path: [...scope, { label: "inbox" }], title: t("title") };

  if (inbox === null) {
    return (
      <InboxPage
        header={header}
        factsLabel={t("inspectorTitle")}
        actionRow={{ primary: { label: t("open"), onSelect: () => {} } }}
        loading={{ facts: { rows: 3, keyWidth: "10ch" } }}
      />
    );
  }
  const detail = active === undefined ? null : detailOf(active, t, locale);
  return (
    <InboxPage
      header={{
        ...header,
        description: t("description"),
        // filtered: the shown items (each type's items are all listed unless truncated)
        count: `${type === null ? inbox.total : (inbox.byType[type] ?? rows.length)}`,
      }}
      {...(rows.length === 0 ? { empty: { text: t("empty"), hint: t("emptyHint") } } : {})}
      open={hashItem.id !== null && rows.some((i) => i.id === hashItem.id)}
      onBack={hashItem.close}
      list={
        <ListDetailList
          label={t("listLabel")}
          items={rows.map((item) => {
            const r = rowOf(item, t, locale);
            return {
              id: item.id,
              title: r.title,
              ...(r.trailing !== null ? { trailing: r.trailing } : {}),
              meta: r.description,
              at: formatDateTime(item.createdAt, "compact", timeZone),
              // everything here waits for a super admin but a transfer, which is a notice
              ...(item.type !== "ownership_transferred" ? { waiting: true } : {}),
            };
          })}
          current={active?.id}
          onOpen={(id) => {
            setActiveId(id);
            hashItem.open(id);
          }}
        />
      }
      {...(active !== undefined && detail !== null
        ? {
            title: detail.title,
            ...(detail.status !== undefined ? { status: detail.status } : {}),
            facts: detail.facts,
            factsLabel: t("inspectorTitle"),
            actionRow: open(active),
          }
        : {})}
    >
      <Stack gap={12}>
        {type !== null && (
          <Stack direction="row" gap={8} align="center">
            <Text variant="small" tone="muted">
              {t("filtered", { type: tt(`inboxTypes.${type}`) })}
            </Text>
            <LinkButton href="/admin/inbox" density="dense">
              {t("clearFilter")}
            </LinkButton>
          </Stack>
        )}
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

/**
 * One list row (spec §5.7): it leads with what the item is about (the plugin's display name), its
 * version beside it (never cut: the name takes the ellipsis), then the kind and the org on the
 * second line.
 */
function rowOf(
  item: PlatformInboxItem,
  t: Translate,
  locale: string,
): { title: string; trailing: string | null; description: string } {
  switch (item.type) {
    case "catalog_request": {
      const version = requestVersion(item.request);
      return {
        title: displayNameOf(requestSubject(item.request), locale),
        trailing: version === null ? null : versionLabel(version),
        description: `${t(`request.kind.${item.request.kind}`)} · ${item.request.orgName}`,
      };
    }
    case "permission_confirmation":
      return {
        title: displayNameOf(item.item, locale),
        trailing: versionLabel(item.item.latestVersion),
        description: t("permission.label"),
      };
    case "scope_sync_failed":
      return {
        title: displayNameOf(item.failure.item, locale),
        trailing: null,
        description: `${t("sync.label")} · ${item.failure.org.name} · ${t(`sync.op.${item.failure.op}`)}`,
      };
    case "extension_disabled":
      return {
        title: displayNameOf(item.disabled.item, locale),
        trailing: versionLabel(item.disabled.extension.version),
        description: t("extensionDisabled.label"),
      };
    case "org_upload_pending":
      return {
        title: displayNameOf(item.item, locale),
        trailing: versionLabel(item.item.pendingVersion ?? item.item.latestVersion),
        description: `${t("orgUpload.label")} · ${ownerOrgOf(item.item)?.name ?? ""}`,
      };
    case "ownership_transferred":
      return {
        title: item.notice.detail.name,
        trailing: null,
        description: `${t("transferred.label")} · ${t("transferred.usedBy", { count: item.notice.detail.usedBy })}`,
      };
  }
}

/** The selected item's card title: the kind, then what it is about. */
function titleOf(item: PlatformInboxItem, t: Translate, locale: string): string {
  switch (item.type) {
    case "catalog_request":
      return `${t(`request.kind.${item.request.kind}`)} · ${displayNameOf(requestSubject(item.request), locale)}`;
    case "permission_confirmation":
      return `${t("permission.label")} · ${displayNameOf(item.item, locale)}`;
    case "scope_sync_failed":
      return `${t("sync.label")} · ${displayNameOf(item.failure.item, locale)}`;
    case "extension_disabled":
      return `${t("extensionDisabled.label")} · ${displayNameOf(item.disabled.item, locale)}`;
    case "org_upload_pending":
      return t("orgUpload.title", {
        org: ownerOrgOf(item.item)?.name ?? "",
        name: displayNameOf(item.item, locale),
      });
    case "ownership_transferred":
      return transferredTitle(item.notice, t);
  }
}

/** 「{name} 已转为平台所有（{org} 已删除它 / {org} 已被删除）」. */
function transferredTitle(n: PlatformNotice, t: Translate): string {
  return t("transferred.title", {
    name: n.detail.name,
    why: t(`transferred.reason.${n.detail.reason}`, { org: n.detail.fromOrg.name }),
  });
}

/** The selected item (spec §6.47): its title and status, its facts and the content after them. */
function detailOf(
  item: PlatformInboxItem,
  t: Translate,
  locale: string,
): { title: string; status?: ReactNode; facts: ListDetailFact[]; content: ReactNode } {
  switch (item.type) {
    case "catalog_request": {
      const r = item.request;
      const version = requestVersion(r);
      return {
        facts: [
          { label: t("org"), value: r.orgName },
          { label: t("request.requester"), value: requesterOf(r) },
          { label: t("request.version"), value: version === null ? "—" : versionLabel(version) },
          { label: t("time"), value: <DateTime value={r.createdAt} /> },
        ],
        title: titleOf(item, t, locale),
        status: <StatusMark status="waiting" label={t("waiting")} />,
        content: (
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
        ),
      };
    }
    case "permission_confirmation": {
      const i = item.item;
      return {
        facts: [
          { label: t("plugin"), value: i.name },
          { label: t("permission.version"), value: versionLabel(i.latestVersion) },
        ],
        title: titleOf(item, t, locale),
        status: <StatusMark status="waiting" label={t("waiting")} />,
        content: (
          <Text variant="prose">
            {i.builtin ? t("permission.hintBuiltin") : t("permission.hint")}
          </Text>
        ),
      };
    }
    case "scope_sync_failed": {
      const f = item.failure;
      return {
        facts: [
          { label: t("plugin"), value: f.item.name },
          { label: t("org"), value: f.org.name },
          { label: t("sync.code"), value: f.code },
          { label: t("time"), value: <DateTime value={f.failedAt} /> },
        ],
        title: titleOf(item, t, locale),
        status: <StatusMark status="failed" label={t("failed")} />,
        content: (
          <Stack gap={8}>
            <Text variant="prose">{t(`sync.hint.${f.op}`, { org: f.org.name })}</Text>
            <Stack gap={4}>
              <Text variant="small" tone="muted">
                {t("sync.message")}
              </Text>
              <Text variant="prose">{f.message}</Text>
            </Stack>
          </Stack>
        ),
      };
    }
    case "extension_disabled": {
      const d = item.disabled;
      return {
        facts: [
          { label: t("plugin"), value: d.item.name },
          { label: t("extensionDisabled.version"), value: versionLabel(d.extension.version) },
          { label: t("extensionDisabled.since"), value: <DateTime value={d.since} /> },
        ],
        title: titleOf(item, t, locale),
        status: <StatusMark status="waiting" label={t("waiting")} />,
        content: <Text variant="prose">{t("extensionDisabled.hint")}</Text>,
      };
    }
    case "org_upload_pending": {
      const i = item.item;
      const version = i.pendingVersion ?? i.latestVersion;
      return {
        facts: [
          { label: t("org"), value: ownerOrgOf(i)?.name ?? "—" },
          { label: t("plugin"), value: i.name },
          {
            label: t("permission.version"),
            value: i.awaitingConfirmation
              ? `${versionLabel(version)} · ${t("orgUpload.newPlugin")}`
              : `${versionLabel(i.latestVersion)} → ${versionLabel(version)}`,
          },
          { label: t("time"), value: <DateTime value={item.createdAt} /> },
        ],
        title: titleOf(item, t, locale),
        status: <StatusMark status="waiting" label={t("waiting")} />,
        content: <Text variant="prose">{t("orgUpload.hint")}</Text>,
      };
    }
    case "ownership_transferred": {
      const d = item.notice.detail;
      return {
        facts: [
          { label: t("org"), value: d.fromOrg.name },
          { label: t("time"), value: <DateTime value={item.createdAt} /> },
        ],
        title: transferredTitle(item.notice, t),
        content: (
          <Stack gap={8}>
            <Text variant="prose">{t("transferred.usedBy", { count: d.usedBy })}</Text>
            <Text variant="prose" tone="muted">
              {t("transferred.hint")}
            </Text>
          </Stack>
        ),
      };
    }
  }
}
