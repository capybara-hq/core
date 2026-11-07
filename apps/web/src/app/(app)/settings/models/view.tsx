"use client";

import { FormSection, SettingsPage } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { usePurposeDrafts } from "../../../../components/PurposeEditor";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import type { ProviderModels } from "../../../../lib/agents";
import { type PurposeTarget, type PurposeView, putOrgPurpose } from "../../../../lib/models";
import { modelsQuery } from "../../../../lib/query/conversation";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { orgPurposesQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/settings/models`：模型用途（组织管理员，SettingsPage）。每个用途显示超级管理员设的部署默认，
 * 组织可以覆盖（选模型与参数）或恢复默认；`eval` 没有生效的映射时提示评测不能开评委（评测向导链到这里）。
 * From the query cache (the layout prefetched it on a first load): the org's purposes and the
 * models they can map to; a saved purpose is written into the cached purposes.
 */
export default function OrgModelsView() {
  const ws = useWorkspace({ min: "admin", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <OrgModels orgId={ws.orgId} />;
}

/**
 * The purposes while they load, as PurposeEditor draws them: the kernel's six (eval, title, web
 * extraction and the three sub-agent tiers), each a row with its one hint (what happens while it
 * is unset) over the model select (its default option names the deployment default).
 */
const purposeRow = (lines: number) => ({
  lines,
  lineSize: "small" as const,
  field: { control: "select" as const },
});
const LOADING_PURPOSES = [1, 1, 1, 1, 1, 1].map(purposeRow);

function OrgModels({ orgId }: { orgId: string }) {
  const scope = usePagePath("org");
  const t = useTranslations("models");
  const nav = useOrgSettingsNav();
  const purposes = usePageQuery(orgPurposesQuery(orgId));
  const models = usePageQuery(modelsQuery(orgId));
  const header = {
    path: [...scope, { label: "settings", href: "/settings/organization" }, { label: "models" }],
    title: t("org.title"),
  };
  if (purposes.kind === "notFound" || models.kind === "notFound") return <NotFound />;
  if (purposes.kind === "error") return <ErrorFrame reset={purposes.retry} />;
  if (models.kind === "error") return <ErrorFrame reset={models.retry} />;
  if (purposes.kind === "loading" || models.kind === "loading") {
    return (
      <SettingsPage
        header={header}
        nav={nav}
        activeNav="models"
        loading={{
          sections: [
            {
              items: LOADING_PURPOSES,
              title: t("org.title"),
              description: t("org.description"),
            },
          ],
        }}
      />
    );
  }
  return (
    <Purposes
      orgId={orgId}
      header={header}
      purposes={purposes.data.purposes}
      providers={models.data.providers}
    />
  );
}

function Purposes({
  orgId,
  header,
  purposes,
  providers,
}: {
  orgId: string;
  header: { path: { label: string; href?: string }[]; title: string };
  purposes: PurposeView[];
  providers: ProviderModels[];
}) {
  const t = useTranslations("models");
  const nav = useOrgSettingsNav();
  const qc = useQueryClient();
  const key = orgPurposesQuery(orgId).queryKey;
  // The answer is the saved purpose: it replaces that purpose in the cache (a functional update:
  // the ActionRow saves several purposes at once).
  const put = useAppMutation({
    fn: (v: { purpose: string; target: PurposeTarget | null }) =>
      putOrgPurpose(orgId, v.purpose, v.target),
    invalidates: () => [],
  });
  const replace = (v: PurposeView) =>
    qc.setQueryData<{ purposes: PurposeView[] }>(key, (d) =>
      d === undefined
        ? d
        : { ...d, purposes: d.purposes.map((p) => (p.purpose === v.purpose ? v : p)) },
    );
  const { list, actionRow } = usePurposeDrafts({
    purposes,
    providers,
    scope: "org",
    save: (purpose, target) => put.mutateAsync({ purpose, target }).then((r) => r.purpose),
    onSaved: replace,
  });
  return (
    <SettingsPage
      header={{ path: header.path, title: header.title }}
      nav={nav}
      activeNav="models"
      {...(actionRow !== undefined ? { actionRow } : {})}
    >
      <FormSection id="purposes" title={t("org.title")} description={t("org.description")} flush>
        {list(t("org.title"))}
      </FormSection>
    </SettingsPage>
  );
}
