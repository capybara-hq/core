"use client";

import {
  type ActionRowProps,
  Badge,
  Field,
  type FieldShape,
  Input,
  ItemList,
  ItemListItem,
  type PageHeaderProps,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError, issueLines } from "../lib/api";
import {
  agentTemplateNameOf,
  chosenByDefault,
  descriptionOf,
  displayNameOf,
  endpointLeaves,
  getPath,
  isOAuth,
  type OrgCatalogDetail,
  type OrgCatalogTemplate,
  setOrgPluginSwitch,
  setPath,
  showValue,
  skillNameOf,
  templateNeed,
} from "../lib/catalog";
import type { AuthType, ConnectorAuth } from "../lib/connectors";
import type { OrgExtension } from "../lib/extensions";
import type { TemplateConnectorInput } from "../lib/pending-connectors";
import { orgCatalogItemQuery, pluginChangeKeys } from "../lib/query/catalog";
import { orgExtensionsQuery } from "../lib/query/channels";
import { retryOnMountOf } from "../lib/query/client";
import { useAppMutation } from "../lib/query/mutation";
import { type PageState, usePageQuery } from "../lib/query/page-query";
import { useErrorMessage } from "../lib/use-error-message";
import { ComponentSection, useCatalogErrorLines } from "./CatalogParts";
import {
  buildCredential,
  buildOAuthClient,
  CredentialFields,
  EMPTY_CREDENTIAL,
  EMPTY_OAUTH_CLIENT,
  type OAuthClientDraft,
  OAuthClientFields,
} from "./ConnectorForm";
import { FormError } from "./form-error";
import { usePagePath } from "./shell/path";

export type TemplateDraft = {
  name: string;
  slug: string;
  endpoint: Record<string, string>;
  credential: typeof EMPTY_CREDENTIAL;
  client: OAuthClientDraft;
};

/** The endpoint fields a template shows: the preset's leaves, plus editable paths it lacks. */
export function endpointFields(
  t: Pick<OrgCatalogTemplate, "endpoint" | "editableEndpoint">,
): { path: string; editable: boolean; preset: unknown }[] {
  const leaves = endpointLeaves(t.endpoint);
  const editable = new Set(t.editableEndpoint);
  const out = leaves.map(([path, preset]) => ({
    path,
    preset,
    editable: [...editable].some((e) => path === e || path.startsWith(`${e}.`)),
  }));
  for (const e of t.editableEndpoint) {
    if (!out.some((f) => f.path === e || f.path.startsWith(`${e}.`))) {
      out.push({ path: e, preset: getPath(t.endpoint, e), editable: true });
    }
  }
  return out;
}

/**
 * 由模板 id 推导默认 slug（与内核规则一致：小写字母开头，小写字母、数字与单个下划线，最长 24 位）；推导不出为空。
 * 显示名可能是中文，内核由名称推导不出 slug，所以默认填上。
 */
export function slugOf(id: string): string {
  const s = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24)
    .replace(/_+$/, "");
  return /^[a-z][a-z0-9_]*$/.test(s) ? s : "";
}

/**
 * A template's default slug: a template with the id `connector` derives it from the plugin's name,
 * any other from the template id.
 */
export const defaultSlug = (t: Pick<OrgCatalogTemplate, "id">, itemName: string): string =>
  slugOf(t.id === "connector" ? itemName : t.id);

export const initialTemplateDraft = (
  t: OrgCatalogTemplate,
  locale: string,
  itemName: string,
): TemplateDraft => ({
  name: t.displayName ? displayNameOf({ name: t.id, displayName: t.displayName }, locale) : "",
  slug: defaultSlug(t, itemName),
  endpoint: Object.fromEntries(
    endpointFields(t)
      .filter((f) => f.editable)
      .map((f) => [f.path, showValue(f.preset)]),
  ),
  credential: EMPTY_CREDENTIAL,
  client: EMPTY_OAUTH_CLIENT,
});

/**
 * A field's text -> the endpoint value: JSON when the preset is not a string (the text otherwise,
 * or when it does not parse).
 */
export function parseValue(raw: string, preset: unknown): unknown {
  if (typeof preset === "string" || preset === undefined) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Detail lines of a failure: for `plugin.install_failed` / `plugin.upgrade_failed`, the cause of the
 * failed step (`causeDetails` as `path: message`); for other errors, the envelope's details.
 */
export function failureLines(e: unknown): string[] {
  if (
    e instanceof ApiClientError &&
    (e.code === "plugin.install_failed" || e.code === "plugin.upgrade_failed")
  ) {
    const cause = (e.rawDetails[0] as { causeDetails?: unknown } | undefined)?.causeDetails;
    if (!Array.isArray(cause)) return [];
    return cause.flatMap((d) => {
      if (typeof d !== "object" || d === null) return [];
      const { path, message } = d as Record<string, unknown>;
      if (typeof message !== "string") return [];
      return [typeof path === "string" && path !== "" ? `${path}: ${message}` : message];
    });
  }
  return issueLines(e);
}

/**
 * What a template still needs before one more connector is made from it, as the kernel checks it:
 * an OAuth client for a manual client, a credential for static auth (the org's; for a personal
 * template the person's own, which lists the tools and is stored as their personal credential);
 * undefined when complete.
 */
export function missingInput(
  t: OrgCatalogTemplate,
  d: TemplateDraft,
): "client" | "credential" | undefined {
  const auth = t.auth;
  if (templateNeed({ auth }) === "client")
    return d.client.clientId.trim() === "" ? "client" : undefined;
  if (auth.type === "none" || isOAuth(auth)) return undefined;
  const credential = buildCredential(
    auth.type as AuthType,
    d.credential,
    Array.isArray(auth.names) ? (auth.names as string[]) : [],
  );
  return credential === undefined ? "credential" : undefined;
}

/** A template draft -> the input of one more connector from that template. */
export function connectorInput(t: OrgCatalogTemplate, d: TemplateDraft): TemplateConnectorInput {
  const endpoint: Record<string, unknown> = {};
  for (const f of endpointFields(t)) {
    if (!f.editable) continue;
    const raw = d.endpoint[f.path] ?? "";
    if (raw === showValue(f.preset)) continue;
    setPath(endpoint, f.path, parseValue(raw, f.preset));
  }
  const auth = t.auth;
  const credential =
    !isOAuth(auth) && auth.type !== "none"
      ? buildCredential(
          auth.type as AuthType,
          d.credential,
          Array.isArray(auth.names) ? (auth.names as string[]) : [],
        )
      : undefined;
  const client = templateNeed({ auth }) === "client" ? buildOAuthClient(d.client) : undefined;
  return {
    ...(d.name.trim() !== "" && { name: d.name.trim() }),
    ...(d.slug.trim() !== "" && { slug: d.slug.trim() }),
    ...(Object.keys(endpoint).length > 0 && { endpoint }),
    ...(credential !== undefined && { credential: credential as Record<string, unknown> }),
    ...(client !== undefined && { client }),
  };
}

/**
 * What the install wizard starts from: the catalog item and the org's extensions (`null` when they
 * could not be read).
 */
export interface CatalogInstallData {
  detail: OrgCatalogDetail;
  extensions: OrgExtension[] | null;
}

/**
 * The install wizard's reads from the query cache (the layout prefetched them on a first load): the
 * item (a 404 is the page's not-found) and the org's extensions (a section). Loading until both
 * answered, so the steps don't change under the person.
 */
export function useCatalogInstall(orgId: string, itemId: string): PageState<CatalogInstallData> {
  const item = usePageQuery(orgCatalogItemQuery(orgId, itemId));
  const extQ = orgExtensionsQuery(orgId);
  const ext = useQuery({ ...extQ, retryOnMount: retryOnMountOf(extQ.queryKey) });
  if (item.kind !== "ready") return item;
  if (ext.data === undefined && ext.error === null) return { kind: "loading" };
  return {
    kind: "ready",
    data: { detail: item.data, extensions: ext.data?.extensions ?? null },
    refreshing: item.refreshing,
  };
}

/** The review's shape while the item is on the way: the summary lines and the template rows. */
const LOADING_FIELDS: FieldShape[] = [{}, {}, {}];

/**
 * What the review hands the page to put into a WizardPage (the page renders the template itself,
 * see check:web-ui's web-ui-template).
 */
export interface WizardView {
  path: PageHeaderProps["path"];
  title: string;
  steps: string[];
  current: number;
  actionRow: ActionRowProps;
  body: ReactNode;
  /** The item is on the way: the page passes it as WizardPage's `loading`. */
  wizardLoading?: { fields: FieldShape[] };
}

/**
 * Enabling a plugin in the org (plugin pages spec §5.3): one review page, then enable (the page puts
 * `frame` into a WizardPage of one step). It asks for nothing: it lists what the org gets (the
 * extension, the connector templates switched on with it, each with what it needs and its icon,
 * the skills, the dependencies installed first). A template that needs an org credential or an
 * OAuth client becomes a needs-configuration connector, set up on the connectors page. A failure shows the
 * failed step (and the dependency it failed in) and says the components this install created were
 * rolled back.
 */
export function CatalogInstallWizard({
  orgId,
  itemId,
  data,
  frame,
}: {
  orgId: string;
  itemId: string;
  /** The item and the org's extensions ({@link useCatalogInstall}); `null` while they load. */
  data: CatalogInstallData | null;
  frame(view: WizardView): ReactNode;
}) {
  const scope = usePagePath("org");
  const t = useTranslations("catalog.org.install");
  const header = (title: string) => ({
    path: [
      ...scope,
      { label: "plugins", href: "/plugins" },
      { label: itemId, href: `/plugins/${encodeURIComponent(itemId)}` },
      { label: "enable" },
    ],
    title,
  });
  if (data === null) {
    return frame({
      ...header(""),
      steps: [t("confirmStep")],
      current: 0,
      actionRow: {
        cancel: { label: t("cancel"), onSelect: () => {} },
        primary: { label: t("submit"), onSelect: () => {} },
      },
      body: null,
      wizardLoading: { fields: LOADING_FIELDS },
    });
  }
  return (
    <Review
      orgId={orgId}
      detail={data.detail}
      orgExtensions={data.extensions ?? []}
      header={header}
      frame={frame}
    />
  );
}

function Review({
  orgId,
  detail,
  orgExtensions,
  header,
  frame,
}: {
  orgId: string;
  detail: OrgCatalogDetail;
  orgExtensions: OrgExtension[];
  header(title: string): PageHeaderProps;
  frame(view: WizardView): ReactNode;
}) {
  const t = useTranslations("catalog.org.install");
  const tr = useTranslations("catalog.admin.review");
  const tp = useTranslations("plugins");
  const tc = useTranslations("catalog.components");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const item = detail.item;
  const name = displayNameOf(item, locale);
  const templateName = (c: OrgCatalogTemplate) =>
    c.displayName ? displayNameOf({ name: c.id, displayName: c.displayName }, locale) : c.connector;
  const own =
    detail.extension === null
      ? undefined
      : orgExtensions.find((o) => o.plugin === detail.extension);
  // The templates on in the org make (or keep) their connectors; default-off ones stay templates
  const templates = detail.templates.filter(chosenByDefault);
  const defaultOff = detail.templates.length - templates.length;
  const needsConfig = templates.some((c) => c.connected !== true && templateNeed(c) !== undefined);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  // Switching it on changes the catalog's view, the installed plugins and what the plugin brings.
  const install = useAppMutation({
    fn: () => setOrgPluginSwitch(orgId, item.id, { enabled: true }),
    invalidates: () => pluginChangeKeys(orgId),
  });
  const installable =
    item.state !== "unavailable" && item.state !== "not_offered" && !item.notDeployed;
  const back = () => router.push(`/plugins/${encodeURIComponent(item.id)}`);

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    try {
      await install.mutateAsync(undefined);
      toast.success(tp("toast.enabled", { name }));
      // An extension that still needs config goes on to its Sheet
      router.push(
        own?.needsConfig === true
          ? `/extensions#plugin=${encodeURIComponent(own.plugin)}`
          : `/plugins/${encodeURIComponent(item.id)}`,
      );
    } catch (e) {
      setError({ message: failureMessage(e), extra: [...failureLines(e), ...catalogLines(e)] });
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * `plugin.install_failed`: explains the failed step (in which dependency, when one failed) and
   * whether it was rolled back; other errors are translated by code.
   */
  const failureMessage = (e: unknown): string => {
    if (e instanceof ApiClientError && e.code === "plugin.install_failed") {
      const d = (e.rawDetails[0] ?? {}) as {
        step?: unknown;
        code?: unknown;
        dependency?: unknown;
        rolledBack?: unknown;
      };
      const stepName =
        typeof d.step === "string" && t.has(`step.${d.step}`)
          ? t(`step.${d.step}`)
          : String(d.step ?? "");
      const code = typeof d.code === "string" ? d.code : "";
      const dependency = typeof d.dependency === "string" ? d.dependency : undefined;
      const message =
        d.rolledBack === false
          ? t("failedNoRollback", { step: stepName, code })
          : t("failed", { step: stepName, code });
      return dependency === undefined ? message : `${message} ${t("failedIn", { dependency })}`;
    }
    return errorMessage(e);
  };

  // Already on: nothing to review.
  if (item.state === "on") {
    return frame({
      ...header(t("title", { name })),
      steps: [t("confirmStep")],
      current: 0,
      actionRow: { primary: { label: t("backToPlugin"), onSelect: back } },
      body: <Text variant="prose">{t("alreadyOn", { name })}</Text>,
    });
  }

  return frame({
    ...header(t("title", { name })),
    steps: [t("confirmStep")],
    current: 0,
    actionRow: {
      cancel: { label: t("cancel"), onSelect: back },
      primary: {
        label: t("submit"),
        onSelect: () => void submit(),
        loading: submitting,
        disabled: submitting || !installable,
      },
    },
    body: (
      <Stack gap={12}>
        {!installable && <FormError message={t("notInstallable")} />}
        <Text variant="prose">{t("summary")}</Text>
        {/* What the package brings, from the org catalog detail (ruling R33): the full
            permission review stayed at the platform import the super admin approved */}
        {detail.extension !== null && (
          <ComponentSection title={tc("extension")} count={1} empty={tc("extensionNone")}>
            <ItemList label={tc("extension")} rows={[{ id: "ext", title: detail.extension }]} />
          </ComponentSection>
        )}
        {detail.skills.length > 0 && (
          <ComponentSection
            title={tc("skills")}
            count={detail.skills.length}
            empty={tc("skillsNone")}
          >
            <ItemList
              label={tc("skills")}
              rows={detail.skills.map((s) => ({ id: s, title: skillNameOf(s) }))}
            />
          </ComponentSection>
        )}
        {/* The connector templates switched on with it: icon, name, what it needs; one the org
            already has a connector for keeps it */}
        {templates.length > 0 && (
          <ComponentSection
            title={tc("templates")}
            count={templates.length}
            empty={tc("templatesNone")}
          >
            <ItemList label={tc("templates")}>
              {templates.map((c) => {
                const need = c.connected === true ? undefined : templateNeed(c);
                const description = descriptionOf(c, locale);
                return (
                  <ItemListItem
                    key={c.id}
                    title={templateName(c)}
                    mark={{ text: templateName(c), image: c.icon ?? null }}
                    marks={
                      need !== undefined && (
                        <Badge>
                          {need === "client" ? tr("needsOAuthClient") : tr("needsOrgCredential")}
                        </Badge>
                      )
                    }
                    meta={
                      c.connected === true ? (
                        <Text variant="small" tone="muted">
                          {t("connectorKept", { name: templateName(c) })}
                        </Text>
                      ) : description !== "" ? (
                        <Text variant="small" tone="muted" truncate>
                          {description}
                        </Text>
                      ) : null
                    }
                  />
                );
              })}
            </ItemList>
          </ComponentSection>
        )}
        {needsConfig && (
          <Text variant="small" tone="muted">
            {t("summaryNeedsConfig")}
          </Text>
        )}
        {defaultOff > 0 && (
          <Text variant="small" tone="muted">
            {t("summaryDefaultOff", { n: defaultOff })}
          </Text>
        )}
        {(detail.agents ?? []).length > 0 && (
          <ComponentSection
            title={tc("agentTemplates")}
            count={detail.agents.length}
            empty={tc("agentTemplatesNone")}
          >
            <ItemList
              label={tc("agentTemplates")}
              rows={detail.agents.map((a) => ({ id: a, title: agentTemplateNameOf(a) }))}
            />
          </ComponentSection>
        )}
        {detail.dependencies.length > 0 && (
          <ComponentSection
            title={tc("dependencies")}
            count={detail.dependencies.length}
            empty={tc("dependenciesNone")}
          >
            <Text variant="small" tone="muted">
              {t("summaryDependencies")}
            </Text>
            <ItemList
              label={tc("dependencies")}
              rows={detail.dependencies.map((d) => ({ id: d.name, title: d.name, meta: d.range }))}
            />
          </ComponentSection>
        )}
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      </Stack>
    ),
  });
}

/**
 * One connector template's input (one more connector from it, `PendingConnectorDialog`): name,
 * slug, the endpoint fields (editable ones as inputs) and the credentials or OAuth client.
 */
export function TemplateStep({
  template,
  draft,
  onChange,
}: {
  template: OrgCatalogTemplate;
  draft: TemplateDraft;
  onChange(next: TemplateDraft): void;
}) {
  const t = useTranslations("catalog.org.install");
  const locale = useLocale();
  const auth = template.auth;
  const oauth = isOAuth(auth);
  const description = descriptionOf(template, locale);
  return (
    <Stack gap={16}>
      {description !== "" && (
        <Text variant="prose" tone="muted">
          {description}
        </Text>
      )}
      <Field label={t("name")}>
        <Input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </Field>
      <Field label={t("slug")} help={t("slugHelp")}>
        <Input value={draft.slug} onChange={(e) => onChange({ ...draft, slug: e.target.value })} />
      </Field>
      <Stack gap={8}>
        <Text>{t("endpoint")}</Text>
        <Text variant="small" tone="muted">
          {t("endpointHint")}
        </Text>
        {endpointFields(template).map((f) => (
          <Field key={f.path} label={f.path}>
            {f.editable ? (
              <Input
                value={draft.endpoint[f.path] ?? ""}
                onChange={(e) =>
                  onChange({
                    ...draft,
                    endpoint: { ...draft.endpoint, [f.path]: e.target.value },
                  })
                }
              />
            ) : (
              <Input value={showValue(f.preset)} readOnly aria-readonly="true" />
            )}
          </Field>
        ))}
      </Stack>
      <Stack gap={8}>
        <Text>{t("credential")}</Text>
        {auth.type === "none" ? (
          <Text variant="prose" tone="muted">
            {t("noneHint")}
          </Text>
        ) : oauth ? (
          templateNeed({ auth }) === "client" ? (
            <OAuthClientFields
              values={draft.client}
              onChange={(client) => onChange({ ...draft, client })}
              secretRequired={auth.type === "oauth_client"}
            />
          ) : (
            <Text variant="prose" tone="muted">
              {t("dcrHint")}
            </Text>
          )
        ) : (
          <>
            <Text variant="small" tone="muted">
              {template.ownership === "personal" ? t("personalHint") : t("credentialHint")}
            </Text>
            <CredentialFields
              auth={auth as unknown as ConnectorAuth}
              values={draft.credential}
              onChange={(credential) => onChange({ ...draft, credential })}
            />
          </>
        )}
      </Stack>
    </Stack>
  );
}
