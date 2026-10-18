"use client";

import { FormPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useAppForm } from "../../../../../components/AppForm";
import { OrgGate } from "../../../../../components/OrgGate";
import { useRouter } from "../../../../../i18n/navigation";
import type { AppDetail } from "../../../../../lib/apps";

/** `/[locale]/apps/new`：安装应用（FormPage；第一段只支持 MCP + 静态认证），成功后进入详情。 */
export default function NewAppPage() {
  return <OrgGate>{(orgId) => <NewApp orgId={orgId} />}</OrgGate>;
}

function NewApp({ orgId }: { orgId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const toDetail = (app: AppDetail) => router.push(`/apps/${encodeURIComponent(app.id)}`);
  const form = useAppForm(orgId, toDetail);
  const installed = form.installed;
  return (
    <FormPage
      header={{ parent: { label: t("apps.title"), href: "/apps" }, title: t("apps.form.title") }}
      anchors={form.anchors}
      actionRow={{
        unsaved: form.unsaved,
        errors: form.errors,
        ...(installed
          ? {}
          : { cancel: { label: t("common.cancel"), onSelect: () => router.push("/apps") } }),
        primary: installed
          ? { label: t("apps.form.continue"), onSelect: () => toDetail(installed) }
          : { label: t("apps.form.submit"), onSelect: form.submit, loading: form.pending },
      }}
    >
      {form.sections}
    </FormPage>
  );
}
