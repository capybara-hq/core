"use client";

import { Button, Card, Field, Input, Stack, Text, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { type OrgCatalogTemplate, setPath, showValue } from "../lib/catalog";
import type { ConnectorDetail, UpdateConnectorInput } from "../lib/connectors";
import { orgCatalogItemQuery } from "../lib/query/catalog";
import { retryOnMountOf } from "../lib/query/client";
import { orgComponentsQuery } from "../lib/query/components";
import { useErrorMessage } from "../lib/use-error-message";
import { endpointFields, parseValue } from "./CatalogInstallWizard";

/**
 * The connector template a connector was made from, as the org's catalog shows it (its
 * `editableEndpoint`, its endpoint presets). With a setup guide whose item has exactly one template
 * on that guide, the item's detail alone; else the template component first (its item and template
 * id), then the item's detail. `template` is undefined for a custom connector, while reading
 * (`loading`), or when unreadable.
 */
export function useConnectorTemplate(
  orgId: string,
  app: Pick<ConnectorDetail, "platformTemplateId" | "setupGuide">,
): { template: OrgCatalogTemplate | undefined; loading: boolean } {
  const templateId = app.platformTemplateId ?? null;
  const guide = templateId === null ? null : (app.setupGuide ?? null);
  const gq = orgCatalogItemQuery(orgId, guide?.itemId ?? "");
  const guideItem = useQuery({
    ...gq,
    enabled: guide !== null,
    retryOnMount: retryOnMountOf(gq.queryKey),
  });
  const onGuide =
    guide === null
      ? []
      : (guideItem.data?.templates ?? []).filter((x) => x.guide?.guideId === guide.guideId);
  const direct = onGuide.length === 1 ? onGuide[0] : undefined;
  // the item answered without one template on that guide (or there is no guide): by component
  const byComponent =
    templateId !== null && direct === undefined && (guide === null || !guideItem.isPending);
  const cq = orgComponentsQuery(orgId, { kind: "connector_template" });
  const components = useQuery({
    ...cq,
    enabled: byComponent,
    retryOnMount: retryOnMountOf(cq.queryKey),
  });
  const component = byComponent
    ? components.data?.components.find((c) => c.id === templateId)
    : undefined;
  const itemId = component?.itemId ?? null;
  const iq = orgCatalogItemQuery(orgId, itemId ?? "");
  const item = useQuery({
    ...iq,
    enabled: itemId !== null,
    retryOnMount: retryOnMountOf(iq.queryKey),
  });
  if (templateId === null) return { template: undefined, loading: false };
  if (direct !== undefined) return { template: direct, loading: false };
  const template =
    component === undefined ? undefined : item.data?.templates.find((x) => x.id === component.name);
  const loading =
    template === undefined &&
    ((guide !== null && guideItem.isPending) ||
      (byComponent && components.isPending) ||
      (itemId !== null && item.isPending));
  return { template, loading };
}

/**
 * endpoint (plugin pages spec §5.3): the endpoint fields a connector's template lets the org edit
 * (`editableEndpoint`; every other part of the endpoint stays the template's), each showing the
 * connector's current value. Saving sends only the changed paths (`PATCH … endpoint`, merged by
 * the kernel); `onSaved` runs after (the configure form records the guide shown). Nothing for a
 * template without editable paths.
 */
export function ConnectorEndpointCard({
  app,
  template,
  update,
  onSaved,
  blocked = false,
}: {
  app: ConnectorDetail;
  template: Pick<OrgCatalogTemplate, "editableEndpoint">;
  update(input: UpdateConnectorInput): Promise<ConnectorDetail>;
  onSaved?(): Promise<void>;
  /** Saving waits (the configure form: until the guide shown can be recorded). */
  blocked?: boolean;
}) {
  const t = useTranslations("connectors.endpointEdit");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  // the connector's endpoint as the presets: its current values at the editable paths
  const fields = endpointFields({
    endpoint: app.endpoint,
    editableEndpoint: template.editableEndpoint,
  }).filter((f) => f.editable);
  const initial = Object.fromEntries(fields.map((f) => [f.path, showValue(f.preset)]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [pending, setPending] = useState(false);
  if (fields.length === 0) return null;
  const changed = fields.filter((f) => (values[f.path] ?? "") !== initial[f.path]);

  async function save() {
    const endpoint: Record<string, unknown> = {};
    for (const f of changed) setPath(endpoint, f.path, parseValue(values[f.path] ?? "", f.preset));
    setPending(true);
    try {
      await update({ endpoint });
      toast.success(t("saved"));
      await onSaved?.();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card title={t("title")}>
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
        {fields.map((f) => (
          <Field key={f.path} label={f.path}>
            <Input
              value={values[f.path] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.path]: e.target.value }))}
            />
          </Field>
        ))}
        <Stack direction="row">
          <Button
            variant="primary"
            loading={pending}
            disabled={changed.length === 0 || blocked}
            onClick={() => void save()}
          >
            {t("save")}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}
