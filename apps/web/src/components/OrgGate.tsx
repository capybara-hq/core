"use client";

import { Button, StatusPage } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { usePathname, useRouter } from "../i18n/navigation";
import { CreateOrgDialog } from "./CreateOrgDialog";
import { activeNavOf } from "./shell/nav";
import { RequireSession, useSession } from "./shell/session";

/**
 * A page that needs a current organization: without one it shows a StatusPage, titled with the
 * page's own name (its sidebar entry), that offers creating an organization when the account has
 * none and may create one, else picking one on the overview; otherwise renders `children(orgId)`.
 * Loading shows RequireSession's skeleton; signed-out visitors are sent to login by (app).
 */
export function OrgGate({ children }: { children: (orgId: string) => ReactNode }) {
  return (
    <RequireSession>
      <OrgGateInner>{children}</OrgGateInner>
    </RequireSession>
  );
}

function OrgGateInner({ children }: { children: (orgId: string) => ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const { me } = useSession();
  const [creating, setCreating] = useState(false);
  if (me.currentOrgId === null) {
    const none = me.memberships.length === 0;
    const offerCreate = none && me.canCreateOrg;
    const nav = activeNavOf(pathname);
    const pageTitle = nav !== "" && !nav.startsWith("ext:") ? t(`nav.${nav}`) : t("home.title");
    return (
      <>
        <StatusPage
          header={{ title: pageTitle }}
          kind="disabled"
          title={none ? t("home.noMemberships") : t("agents.noOrg")}
          description={
            none
              ? offerCreate
                ? t("home.noMembershipsCreateHint")
                : t("home.noMembershipsHint")
              : t("agents.noOrgHint")
          }
          action={
            offerCreate ? (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t("home.createOrg.open")}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => router.push("/")}>
                {t("agents.backHome")}
              </Button>
            )
          }
        />
        {offerCreate ? <CreateOrgDialog open={creating} onOpenChange={setCreating} /> : null}
      </>
    );
  }
  return children(me.currentOrgId);
}
