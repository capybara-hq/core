"use client";

import { Stack, Text, useToast, WizardPage } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import {
  connectorInput,
  failureLines,
  initialTemplateDraft,
  missingInput,
  needsClient,
  type TemplateDraft,
  TemplateStep,
} from "../../../../../components/CatalogInstallWizard";
import { useCatalogErrorLines } from "../../../../../components/CatalogParts";
import { ErrorFrame } from "../../../../../components/ErrorFrame";
import { FormError } from "../../../../../components/form-error";
import { NoAccess } from "../../../../../components/NoAccess";
import { usePagePath } from "../../../../../components/shell/path";
import { useRouter } from "../../../../../i18n/navigation";
import {
  createPluginConnectors,
  displayNameOf,
  type OrgCatalogDetail,
} from "../../../../../lib/catalog";
import { orgCatalogItemQuery, pluginChangeKeys } from "../../../../../lib/query/catalog";
import { useAppMutation } from "../../../../../lib/query/mutation";
import { usePageQuery } from "../../../../../lib/query/page-query";
import { useWorkspace } from "../../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import NotFound from "../../../not-found";

/**
 * `/plugins/[itemId]/connectors`: 补充配置 (ruling P2-10). An installed plugin whose connector
 * templates on in the org miss a connector there (`needs_config`, e.g. a template a platform
 * update added) asks for each one's input with the install wizard's template step, then creates
 * them (`POST …/catalog/:itemId/connectors`). Nothing missing: says so and goes back.
 */
export default function PluginConnectorsView({
  itemId,
  fromConnectors = false,
}: {
  itemId: string;
  /** Opened from a `/connectors` card (`?from=connectors`): the path and the way back lead there. */
  fromConnectors?: boolean;
}) {
  const ws = useWorkspace({ min: "admin", setup: "step" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return (
    <Connectors key={itemId} orgId={ws.orgId} itemId={itemId} fromConnectors={fromConnectors} />
  );
}

function Connectors({
  orgId,
  itemId,
  fromConnectors,
}: {
  orgId: string;
  itemId: string;
  fromConnectors: boolean;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.org.connectors");
  const read = usePageQuery(orgCatalogItemQuery(orgId, itemId));
  const path = fromConnectors
    ? [...scope, { label: "connectors", href: "/connectors" }, { label: "setup" }]
    : [
        ...scope,
        { label: "plugins", href: "/plugins" },
        { label: itemId, href: `/plugins/${encodeURIComponent(itemId)}` },
        { label: "connectors" },
      ];
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  if (read.kind === "loading") {
    return (
      <WizardPage
        header={{ path, title: "" }}
        steps={[t("confirmStep")]}
        current={0}
        actionRow={{ primary: { label: t("next"), onSelect: () => {} } }}
        loading={{ fields: [{}, {}, {}] }}
      />
    );
  }
  return (
    <Wizard
      key={read.data.item.id}
      orgId={orgId}
      detail={read.data}
      path={path}
      backTo={fromConnectors ? "/connectors" : `/plugins/${encodeURIComponent(itemId)}`}
    />
  );
}

function Wizard({
  orgId,
  detail,
  path,
  backTo,
}: {
  orgId: string;
  detail: OrgCatalogDetail;
  path: { label: string; href?: string }[];
  /** Where done, cancel and "nothing to do" lead. */
  backTo: string;
}) {
  const t = useTranslations("catalog.org.connectors");
  const ti = useTranslations("catalog.org.install");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const item = detail.item;
  const name = displayNameOf(item, locale);
  const templates = detail.missingTemplates ?? [];
  const steps = [
    ...templates.map((c) =>
      ti("connectorStep", {
        name: c.displayName
          ? displayNameOf({ name: c.id, displayName: c.displayName }, locale)
          : c.connector,
      }),
    ),
    t("confirmStep"),
  ];
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>(() =>
    Object.fromEntries(templates.map((c) => [c.id, initialTemplateDraft(c, locale, item.name)])),
  );
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const [submitting, setSubmitting] = useState(false);
  // New connectors change the plugin's state (needs_config -> on) and the org's connectors.
  const create = useAppMutation({
    fn: () =>
      createPluginConnectors(
        orgId,
        item.id,
        Object.fromEntries(
          templates.map((c) => [c.id, connectorInput(c, drafts[c.id] as TemplateDraft)]),
        ),
      ),
    invalidates: () => pluginChangeKeys(orgId),
  });
  const back = () => router.push(backTo);
  const header = { path, title: t("title", { name }) };

  if (templates.length === 0) {
    return (
      <WizardPage
        header={header}
        steps={[t("confirmStep")]}
        current={0}
        actionRow={{ primary: { label: t("backToPlugin"), onSelect: back } }}
      >
        <Text variant="prose">{t("nothing", { name })}</Text>
      </WizardPage>
    );
  }

  const confirmIdx = steps.length - 1;
  const template = step < templates.length ? templates[step] : undefined;
  const draft = template ? drafts[template.id] : undefined;
  // A manual OAuth client and a personal template's own credential are required before going on
  const incomplete =
    template !== undefined &&
    draft !== undefined &&
    (needsClient(template.auth) || template.ownership === "personal") &&
    missingInput(template, draft) !== undefined;

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await create.mutateAsync(undefined);
      toast.success(t("done", { name }));
      back();
    } catch (e) {
      setError({ message: errorMessage(e), extra: [...failureLines(e), ...catalogLines(e)] });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WizardPage
      header={header}
      steps={steps}
      current={step}
      actionRow={{
        cancel: { label: ti("cancel"), onSelect: back },
        ...(step > 0 && {
          secondary: {
            label: ti("back"),
            onSelect: () => setStep((s) => s - 1),
            disabled: submitting,
          },
        }),
        primary:
          step === confirmIdx
            ? {
                label: t("submit"),
                onSelect: () => void submit(),
                loading: submitting,
                disabled: submitting,
              }
            : {
                label: ti("next"),
                onSelect: () => setStep((s) => Math.min(s + 1, confirmIdx)),
                disabled: incomplete,
              },
      }}
    >
      {/*
        Slot: the template's setup guide (setup guides v2, a later task) goes here, above the
        template's input, so the admin reads where to get the OAuth client or endpoint first.
      */}
      {template !== undefined && draft !== undefined && (
        <TemplateStep
          template={template}
          draft={draft}
          onChange={(next) => setDrafts((d) => ({ ...d, [template.id]: next }))}
        />
      )}
      {step === confirmIdx && (
        <Stack gap={12}>
          <Text variant="prose">{t("summary", { n: templates.length })}</Text>
          {error !== undefined && <FormError message={error.message} extra={error.extra} />}
        </Stack>
      )}
    </WizardPage>
  );
}
