"use client";

import {
  Button,
  Card,
  Field,
  KeyValue,
  OverviewPage,
  Select,
  Stack,
  StatusPage,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { CreateOrgDialog } from "../../components/CreateOrgDialog";
import { RequireSession, useSession } from "../../components/shell/session";

/**
 * `/`: the overview — greeting, the current organization (switchable), "Create an
 * organization" when the account may, and the way into Agents. Without any membership it shows a
 * StatusPage that offers creating one (or says to ask for an invitation when the deployment only
 * lets enterprise admins create organizations). Signed-out visitors are sent to login by (app).
 */
export default function HomePage() {
  return (
    <RequireSession>
      <Home />
    </RequireSession>
  );
}

function Home() {
  const t = useTranslations("home");
  const { me, switchOrg } = useSession();
  const [creating, setCreating] = useState(false);
  const dialog = me.canCreateOrg ? (
    <CreateOrgDialog open={creating} onOpenChange={setCreating} />
  ) : null;

  if (me.memberships.length === 0) {
    return (
      <>
        <StatusPage
          header={{ title: t("title") }}
          kind="disabled"
          title={t("noMemberships")}
          description={me.canCreateOrg ? t("noMembershipsCreateHint") : t("noMembershipsHint")}
          action={
            me.canCreateOrg ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t("createOrg.open")}
              </Button>
            ) : undefined
          }
        />
        {dialog}
      </>
    );
  }

  const current = me.memberships.find((m) => m.orgId === me.currentOrgId);
  const options = [
    // 首项「选择组织」：选回它即清除当前组织（与旧版行为一致）
    { value: "", label: t("selectOrg") },
    ...me.memberships.map((m) => ({ value: m.orgId, label: m.name })),
  ];
  return (
    <OverviewPage
      header={{
        title: t("greeting", { name: me.account.displayName }),
        actions: [
          ...(me.canCreateOrg
            ? [
                {
                  label: t("createOrg.open"),
                  icon: "plus" as const,
                  variant: "default" as const,
                  onSelect: () => setCreating(true),
                },
              ]
            : []),
          ...(current === undefined
            ? []
            : [{ label: t("openAgents"), variant: "primary" as const, href: "/agents" }]),
        ],
      }}
    >
      <Card title={t("orgCard")}>
        <Stack gap={16}>
          <Field label={t("currentOrg")}>
            <Select
              options={options}
              value={me.currentOrgId ?? ""}
              onChange={(e) => void switchOrg(e.target.value === "" ? null : e.target.value)}
            />
          </Field>
          {current === undefined ? (
            <Text tone="muted">{t("noCurrentOrg")}</Text>
          ) : (
            <KeyValue
              rows={[
                { k: t("slug"), v: current.slug },
                { k: t("role"), v: current.role },
              ]}
            />
          )}
        </Stack>
      </Card>
      {dialog}
    </OverviewPage>
  );
}
