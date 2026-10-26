"use client";

import { FormPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useAgentForm } from "../../../../../components/AgentForm";
import { OrgGate } from "../../../../../components/OrgGate";
import { useRouter } from "../../../../../i18n/navigation";

/** `/[locale]/agents/new`：新建 agent（FormPage），保存后回到列表。 */
export default function NewAgentPage() {
  return <OrgGate>{(orgId) => <NewAgent orgId={orgId} />}</OrgGate>;
}

function NewAgent({ orgId }: { orgId: string }) {
  const t = useTranslations();
  const router = useRouter();
  const done = () => router.push("/agents");
  const form = useAgentForm(orgId, done);
  return (
    <FormPage
      header={{
        breadcrumb: [{ label: t("agents.title"), href: "/agents" }],
        title: t("agents.form.title"),
      }}
      actionRow={{
        unsaved: form.unsaved,
        errors: form.errors,
        ...(form.saved ? {} : { cancel: { label: t("common.cancel"), onSelect: done } }),
        primary: form.saved
          ? { label: t("agents.form.continue"), onSelect: done }
          : {
              label: t("agents.form.submit"),
              onSelect: form.submit,
              loading: form.pending,
              disabled: !form.canSubmit,
            },
      }}
    >
      {form.sections}
    </FormPage>
  );
}
