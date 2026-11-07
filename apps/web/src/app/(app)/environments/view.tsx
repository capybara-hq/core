"use client";

import { ListPage, ObjectCard } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { EnvironmentCreateDialog } from "../../../components/EnvironmentCreateDialog";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { NoAccess } from "../../../components/NoAccess";
import { usePagePath } from "../../../components/shell/path";
import { type Environment, environmentState } from "../../../lib/environments";
import { environmentsQuery } from "../../../lib/query/environments";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";

/**
 * `/environments` (环境): the person's environments as cards (the default shows as 个人环境): source,
 * state (运行中 / 已暂停 / 未启动 / 文件已丢失 / 不可用) and whether sessions are isolated; a card opens
 * the environment's page. 新建环境 opens a dialog; without a sandbox provider the page says the platform
 * has no cloud sandbox and offers no 新建环境; the environments it still has are listed as 不可用 under
 * a notice (they can be deleted). From the query cache (the layout prefetched it on a
 * first load).
 */
export default function EnvironmentsView() {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Environments orgId={ws.orgId} />;
}

function Environments({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("environments");
  const [creating, setCreating] = useState(false);
  const list = usePageQuery(environmentsQuery(orgId));
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const cloud = list.kind === "ready" && list.data.cloudAvailable;
  const header = {
    path: [...scope, { label: "environments" }],
    title: t("title"),
    ...(cloud
      ? {
          actions: [
            { label: t("new"), variant: "primary" as const, onSelect: () => setCreating(true) },
          ],
        }
      : {}),
  };
  const common = { variant: "cards" as const, listLabel: t("listLabel") };
  if (list.kind === "loading")
    return <ListPage header={header} {...common} loading={{ rows: 3 }} />;
  const items = list.data.items;
  // Without a provider the existing environments are still listed (as 不可用) and deletable; the
  // empty state is only for a list with nothing in it.
  const empty =
    items.length > 0
      ? undefined
      : !list.data.cloudAvailable
        ? { text: t("noCloud.text"), hint: t("noCloud.hint") }
        : { text: t("empty") };
  const callout =
    items.length > 0 && !list.data.cloudAvailable
      ? { tone: "warn" as const, children: t("noCloud.notice") }
      : undefined;
  return (
    <>
      <ListPage
        header={header}
        {...common}
        {...(empty ? { empty } : {})}
        {...(callout ? { callout } : {})}
      >
        {items.map((e) => (
          <EnvironmentCard key={e.id} environment={e} />
        ))}
      </ListPage>
      {creating && <EnvironmentCreateDialog orgId={orgId} onClose={() => setCreating(false)} />}
    </>
  );
}

function EnvironmentCard({ environment: e }: { environment: Environment }) {
  const t = useTranslations("environments");
  const state = environmentState(e);
  return (
    <ObjectCard
      avatar={{ icon: "cpu" }}
      title={e.name ?? t("personal")}
      href={`/environments/${encodeURIComponent(e.id)}`}
      description={t(`source.${e.source}`)}
      meta={[
        state === "filesLost" || state === "unavailable"
          ? { label: t(`state.${state}`), tone: "warn" as const }
          : t(`state.${state}`),
        t(e.sessionIsolation ? "isolation.isolated" : "isolation.shared"),
      ]}
    />
  );
}
