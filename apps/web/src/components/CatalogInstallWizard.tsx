"use client";

import {
  type ActionRowProps,
  Card,
  Field,
  Input,
  type PageHeaderProps,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError, issueLines } from "../lib/api";
import {
  type ConnectorInstallInput,
  displayNameOf,
  endpointLeaves,
  getOrgCatalogItem,
  getPath,
  installCatalogItem,
  isOAuth,
  type OrgCatalogDetail,
  type OrgCatalogTemplate,
  type OrgInstallBody,
  setPath,
  showValue,
} from "../lib/catalog";
import type { AuthType, ConnectorAuth } from "../lib/connectors";
import { listOrgExtensions, type OrgExtension } from "../lib/extensions";
import { useErrorMessage } from "../lib/use-error-message";
import { useLoad } from "../lib/use-load";
import { useCatalogErrorLines } from "./CatalogParts";
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
import {
  draftToConfig,
  initialDraft,
  type SchemaDraft,
  SchemaForm,
  schemaFields,
} from "./SchemaForm";

export type TemplateDraft = {
  name: string;
  slug: string;
  endpoint: Record<string, string>;
  credential: typeof EMPTY_CREDENTIAL;
  client: OAuthClientDraft;
};

/** 模板里要显示的端点字段：预设的叶子，加上预设里没有、但组织可改的路径。 */
export function endpointFields(
  t: OrgCatalogTemplate,
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

/** OAuth 模板是否要组织填客户端：客户端凭据流总要；授权码流只在手填客户端时要（自动注册时不要）。 */
export const needsClient = (auth: Record<string, unknown>) =>
  auth.type === "oauth_client" || (auth.type === "oauth_code" && auth.client === "manual");

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

/** 输入框里的值 → 端点值：预设不是字符串时按 JSON 解析（解析失败按字符串）。 */
function parseValue(raw: string, preset: unknown): unknown {
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
 * What a template still needs before submitting, as the kernel checks it: an OAuth client for a
 * manual client, an org credential for static auth owned by the org; undefined when complete.
 */
export function missingInput(
  t: OrgCatalogTemplate,
  d: TemplateDraft,
): "client" | "credential" | undefined {
  const auth = t.auth;
  if (needsClient(auth)) return d.client.clientId.trim() === "" ? "client" : undefined;
  if (auth.type === "none" || isOAuth(auth) || t.ownership !== "org") return undefined;
  const credential = buildCredential(
    auth.type as AuthType,
    d.credential,
    Array.isArray(auth.names) ? (auth.names as string[]) : [],
  );
  return credential === undefined ? "credential" : undefined;
}

/** 一个模板草稿 → 安装请求里的连接器输入。 */
export function connectorInput(t: OrgCatalogTemplate, d: TemplateDraft): ConnectorInstallInput {
  const endpoint: Record<string, unknown> = {};
  for (const f of endpointFields(t)) {
    if (!f.editable) continue;
    const raw = d.endpoint[f.path] ?? "";
    if (raw === showValue(f.preset)) continue;
    setPath(endpoint, f.path, parseValue(raw, f.preset));
  }
  const auth = t.auth;
  const credential =
    !isOAuth(auth) && auth.type !== "none" && t.ownership !== "personal"
      ? buildCredential(
          auth.type as AuthType,
          d.credential,
          Array.isArray(auth.names) ? (auth.names as string[]) : [],
        )
      : undefined;
  const client = needsClient(auth) ? buildOAuthClient(d.client) : undefined;
  return {
    ...(d.name.trim() !== "" && { name: d.name.trim() }),
    ...(d.slug.trim() !== "" && { slug: d.slug.trim() }),
    ...(Object.keys(endpoint).length > 0 && { endpoint }),
    ...(credential !== undefined && { credential: credential as Record<string, unknown> }),
    ...(client !== undefined && { client }),
  };
}

/** 向导交给页面放进 WizardPage 的部分（页面文件自己渲染模板，见 check:web-ui 的 web-ui-template）。 */
export interface WizardView {
  header: PageHeaderProps;
  steps: string[];
  current: number;
  actionRow: ActionRowProps;
  body: ReactNode;
}

/**
 * The wizard that installs a plugin from the catalog (the page puts `frame` into a WizardPage): for
 * each of its connector templates, the name, the editable endpoint fields (the rest read-only),
 * credentials or client id / secret; a plugin with an extension has a step for that extension's org
 * config (asked only when this install enables it and it has org config); then confirm, listing the
 * components and the dependencies installed with it (they take no input). A failure shows the failed
 * step (and the dependency it failed in) and says the components this install created were rolled
 * back.
 */
export function CatalogInstallWizard({
  orgId,
  itemId,
  frame,
}: {
  orgId: string;
  itemId: string;
  frame(view: WizardView): ReactNode;
}) {
  const t = useTranslations("catalog.org.install");
  const to = useTranslations("catalog.org");
  const errorMessage = useErrorMessage();
  const detail = useLoad(() => getOrgCatalogItem(orgId, itemId), [orgId, itemId]);
  const extensions = useLoad(
    () =>
      listOrgExtensions(orgId)
        .then((r) => r.extensions)
        .catch(() => [] as OrgExtension[]),
    [orgId],
  );
  const header = (title: string) => ({
    parent: { label: to("title"), href: `/catalog/${itemId}` },
    title,
  });
  if (detail.state.kind !== "ready" || extensions.state.kind !== "ready") {
    return frame({
      header: header(to("title")),
      steps: [t("confirmStep")],
      current: 0,
      actionRow: { primary: { label: t("submit"), onSelect: () => {}, disabled: true } },
      body:
        detail.state.kind === "error" ? (
          <FormError
            message={errorMessage(new ApiClientError(0, detail.state.code, detail.state.code))}
          />
        ) : (
          <Skeleton rows={6} />
        ),
    });
  }
  return (
    <Wizard
      orgId={orgId}
      detail={detail.state.data}
      orgExtensions={extensions.state.data}
      header={header}
      frame={frame}
    />
  );
}

function Wizard({
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
  const ta = useTranslations("catalog.org.action");
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const catalogLines = useCatalogErrorLines();
  const item = detail.item;
  const name = displayNameOf(item, locale);
  const templates = detail.templates;
  // The plugin's own extension in this org: its org config is asked only when this install enables it
  const own =
    detail.extension === null
      ? undefined
      : orgExtensions.find((o) => o.plugin === detail.extension);
  const withConfig =
    own !== undefined && !own.enabled && schemaFields(own.orgConfigSchema).length > 0
      ? own
      : undefined;
  const hasExtensionStep = detail.extension !== null;
  const steps = [
    ...templates.map((c) =>
      t("connectorStep", {
        name: c.displayName
          ? displayNameOf({ name: c.id, displayName: c.displayName }, locale)
          : c.connector,
      }),
    ),
    ...(hasExtensionStep ? [t("extensionStep")] : []),
    t("confirmStep"),
  ];
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>(() =>
    Object.fromEntries(templates.map((c) => [c.id, initialTemplateDraft(c, locale, item.name)])),
  );
  const [config, setConfig] = useState<SchemaDraft>(() =>
    withConfig ? initialDraft(withConfig.orgConfigSchema, null) : {},
  );
  const [showRequired, setShowRequired] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  const confirmIdx = steps.length - 1;
  const extensionIdx = hasExtensionStep ? confirmIdx - 1 : -1;
  const installable = item.installable === "yes" || item.installable === "granted";

  const template = step < templates.length ? templates[step] : undefined;
  const draft = template ? drafts[template.id] : undefined;
  const setDraft = (next: TemplateDraft) => {
    if (template) setDrafts((d) => ({ ...d, [template.id]: next }));
  };
  const templateIncomplete =
    template !== undefined &&
    draft !== undefined &&
    needsClient(template.auth) &&
    draft.client.clientId.trim() === "";
  const configResult = withConfig
    ? draftToConfig(schemaFields(withConfig.orgConfigSchema), config, "create")
    : undefined;
  const configErrors = configResult !== undefined && Object.keys(configResult.errors).length > 0;

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    const body: OrgInstallBody = {
      version: item.latestVersion,
      ...(templates.length > 0 && {
        connectors: Object.fromEntries(
          templates.map((c) => [c.id, connectorInput(c, drafts[c.id] as TemplateDraft)]),
        ),
      }),
      ...(configResult !== undefined && { extensionConfig: configResult.config }),
    };
    try {
      const r = await installCatalogItem(orgId, item.id, body);
      if ("request" in r) {
        toast.success(ta("approvalRequested"));
        router.push(`/catalog/${item.id}`);
        return;
      }
      toast.success(ta("installed", { name }));
      router.push("/settings/plugins");
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

  const next = () => {
    if (step === extensionIdx && configErrors) {
      setShowRequired(true);
      return;
    }
    setStep((s) => Math.min(s + 1, confirmIdx));
  };

  const actionRow = {
    cancel: { label: t("cancel"), onSelect: () => router.push(`/catalog/${item.id}`) },
    ...(step > 0 && {
      secondary: { label: t("back"), onSelect: () => setStep((s) => s - 1), disabled: submitting },
    }),
    primary:
      step === confirmIdx
        ? {
            label: t("submit"),
            onSelect: () => void submit(),
            loading: submitting,
            disabled: submitting || !installable,
          }
        : { label: t("next"), onSelect: next, disabled: templateIncomplete },
  };

  return frame({
    header: header(t("title", { name })),
    steps,
    current: step,
    actionRow,
    body: (
      <>
        {template !== undefined && draft !== undefined && (
          <TemplateStep template={template} draft={draft} onChange={setDraft} />
        )}
        {step === extensionIdx && (
          <Stack gap={16}>
            <Text tone="muted">{t("extensionHint")}</Text>
            {own?.enabled === true && (
              <Text variant="small" tone="muted">
                {t("extensionEnabled", { name: own.plugin })}
              </Text>
            )}
            {withConfig === undefined && own?.enabled !== true && (
              <Text tone="muted">{t("extensionNone")}</Text>
            )}
            {withConfig !== undefined && (
              <Card title={withConfig.plugin}>
                <SchemaForm
                  schema={withConfig.orgConfigSchema}
                  draft={config}
                  onChange={setConfig}
                  mode="create"
                  showRequired={showRequired}
                />
              </Card>
            )}
          </Stack>
        )}
        {step === confirmIdx && (
          <Stack gap={12}>
            {!installable && <FormError message={t("notInstallable")} />}
            <Text>{t("summary")}</Text>
            <Text variant="small" tone="muted">
              {[
                detail.extension !== null
                  ? t("summaryExtension", { name: detail.extension })
                  : null,
                templates.length > 0 ? t("summaryTemplates", { n: templates.length }) : null,
                detail.skills.length > 0 ? t("summarySkills", { n: detail.skills.length }) : null,
              ]
                .filter((s) => s !== null)
                .join(" · ")}
            </Text>
            {detail.dependencies.length > 0 && (
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {t("summaryDependencies")}
                </Text>
                {detail.dependencies.map((d) => (
                  <Text key={d.name} variant="small">{`· ${d.name} ${d.range}`}</Text>
                ))}
              </Stack>
            )}
            {error !== undefined && <FormError message={error.message} extra={error.extra} />}
          </Stack>
        )}
      </>
    ),
  });
}

/**
 * One connector template's input: name, slug, the endpoint fields (editable ones as inputs) and the
 * credentials or OAuth client. `credentialsOnly` (an upgrade whose template changed its auth): only
 * the credentials, since an existing connector keeps its name, slug and endpoint.
 */
export function TemplateStep({
  template,
  draft,
  onChange,
  credentialsOnly = false,
}: {
  template: OrgCatalogTemplate;
  draft: TemplateDraft;
  onChange(next: TemplateDraft): void;
  credentialsOnly?: boolean;
}) {
  const t = useTranslations("catalog.org.install");
  const auth = template.auth;
  const oauth = isOAuth(auth);
  return (
    <Stack gap={16}>
      {template.description !== "" && <Text tone="muted">{template.description}</Text>}
      {!credentialsOnly && (
        <>
          <Field label={t("name")}>
            <Input
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label={t("slug")} help={t("slugHelp")}>
            <Input
              value={draft.slug}
              onChange={(e) => onChange({ ...draft, slug: e.target.value })}
            />
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
        </>
      )}
      <Stack gap={8}>
        <Text>{t("credential")}</Text>
        {auth.type === "none" ? (
          <Text tone="muted">{t("noneHint")}</Text>
        ) : oauth ? (
          needsClient(auth) ? (
            <OAuthClientFields
              values={draft.client}
              onChange={(client) => onChange({ ...draft, client })}
              secretRequired={auth.type === "oauth_client"}
            />
          ) : (
            <Text tone="muted">{t("dcrHint")}</Text>
          )
        ) : template.ownership === "personal" ? (
          <Text tone="muted">{t("personalHint")}</Text>
        ) : (
          <>
            <Text variant="small" tone="muted">
              {t("credentialHint")}
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
