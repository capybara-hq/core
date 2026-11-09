"use client";

import { Button, FormSection, LinkButton, Sheet } from "@capybara-hq/design";
import { useQueries } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { OrgCatalogTemplate } from "../lib/catalog";
import type { ConnectorSummary } from "../lib/connectors";
import { labelLocale } from "../lib/extension-label";
import { retryOnMountOf } from "../lib/query/client";
import { memberGuideQuery } from "../lib/query/setup";
import { SetupGuideSection } from "./SetupGuideSection";

/**
 * The connector template place of setup guides v2 (spec §9.3) on the org's pages: the admin guide
 * above a template's input in the wizards, and the member's 如何连接 sheet.
 */

/**
 * 接入指南 above a connector template's input (the install wizard's template step, 补充配置): the
 * admin text, read before the client fields because the admin registers `{{oauthCallbackUrl}}` at
 * the third party before they have a client id. Live checks, but no target while the wizard is open
 * (its connectors are created on submit), so the rows say 保存后检查. Nothing without a guide.
 */
export function TemplateGuideSection({
  orgId,
  template,
}: {
  orgId: string;
  template: Pick<OrgCatalogTemplate, "id" | "guide">;
}) {
  const t = useTranslations("setupGuide");
  if (!template.guide) return null;
  return (
    <FormSection
      id={`guide-${template.id}`}
      layout="stacked"
      title={t("title")}
      description={t("templateHint")}
    >
      <SetupGuideSection
        key={template.id}
        orgId={orgId}
        guide={template.guide}
        query={{ audience: "admin" }}
        checks="live"
      />
    </FormSection>
  );
}

/**
 * Which of `connectors` have a member section in their template's guide (spec §9.3: the 如何连接
 * link shows only then), by id. One read per connector with a guide, shared with the sheet.
 */
export function useMemberGuides(orgId: string, connectors: readonly ConnectorSummary[]) {
  const locale = labelLocale(useLocale());
  const withGuide = connectors.filter((c) => c.setupGuide);
  const reads = useQueries({
    queries: withGuide.map((c) => {
      const q = memberGuideQuery(orgId, c, locale);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  return new Set(
    withGuide.flatMap((c, i) => (reads[i]?.data?.audiences.includes("member") ? [c.id] : [])),
  );
}

/**
 * 如何连接 / How to connect: the member text of a connector's template guide for this connector
 * (an org admin reads it as a member would, spec §8), and for org admins a link to the admin text
 * on the connector's page (spec §9.3, decided 2026-11-09); members never see that link.
 */
export function ConnectorGuideSheet({
  orgId,
  connector,
  admin,
  onClose,
}: {
  orgId: string;
  connector: ConnectorSummary;
  /** The viewer manages connectors (`connectors.manage`). */
  admin: boolean;
  onClose(): void;
}) {
  const t = useTranslations("setupGuide");
  const guide = connector.setupGuide;
  if (!guide) return null;
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t("howToConnectTitle", { name: connector.name })}
      mark={{ text: connector.name, image: connector.icon ?? null }}
      width={720}
      footer={
        <>
          {admin && (
            <LinkButton href={`/connectors/${encodeURIComponent(connector.id)}?tab=guide`}>
              {t("adminGuideLink")}
            </LinkButton>
          )}
          <Button variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
        </>
      }
    >
      <SetupGuideSection
        orgId={orgId}
        guide={guide}
        query={{ connectorId: connector.id, audience: "member" }}
        checks="live"
      />
    </Sheet>
  );
}
