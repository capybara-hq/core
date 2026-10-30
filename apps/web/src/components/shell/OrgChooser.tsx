"use client";

import { AuthPage, Button, ItemList, Stack, Text, TextLink } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { usePreferences } from "../../lib/preferences";
import { CreateOrgDialog } from "../CreateOrgDialog";
import { useSession } from "./session";

/**
 * Signed in without a current organization (setup skipped it, several orgs and none chosen yet, or
 * the remembered one is gone): this page covers the whole shell. Pick one of your orgs or create
 * one; either becomes the current org (remembered for the next sign-in) and the app opens.
 * Enterprise admins can also go to the admin console, which needs no org.
 */
export function OrgChooser({ onLogout }: { onLogout(): void }) {
  const t = useTranslations("orgChooser");
  const tRoles = useTranslations("members.roles");
  const { me, switchOrg } = useSession();
  const preferences = usePreferences();
  const [creating, setCreating] = useState(false);
  const [entering, setEntering] = useState<string>();
  const none = me.memberships.length === 0;

  async function enter(orgId: string) {
    setEntering(orgId);
    try {
      await switchOrg(orgId);
    } finally {
      setEntering(undefined);
    }
  }

  return (
    <AuthPage
      title={none ? t("titleNone") : t("title")}
      subtitle={
        none
          ? me.canCreateOrg
            ? t("subtitleCreate")
            : t("subtitleAsk")
          : t("subtitle", { name: me.account.displayName })
      }
      preferences={preferences}
      footer={
        <Stack direction="row" gap={16} justify="center" wrap>
          {me.account.isEnterpriseAdmin ? <TextLink href="/admin">{t("admin")}</TextLink> : null}
          <Button variant="ghost" onClick={onLogout}>
            {t("logout")}
          </Button>
        </Stack>
      }
    >
      <Stack gap={16}>
        {none ? null : (
          <ItemList
            label={t("listLabel")}
            rows={me.memberships.map((m) => ({
              id: m.orgId,
              title: m.name,
              meta: tRoles(m.role as "owner"),
              actions: (
                <Button
                  variant="primary"
                  density="dense"
                  loading={entering === m.orgId}
                  onClick={() => void enter(m.orgId)}
                >
                  {t("enter")}
                </Button>
              ),
            }))}
          />
        )}
        {me.canCreateOrg ? (
          <Button
            variant={none ? "primary" : "default"}
            density="prominent"
            onClick={() => setCreating(true)}
          >
            {t("create")}
          </Button>
        ) : none ? (
          <Text tone="muted">{t("askHint")}</Text>
        ) : null}
      </Stack>
      {me.canCreateOrg ? <CreateOrgDialog open={creating} onOpenChange={setCreating} /> : null}
    </AuthPage>
  );
}
