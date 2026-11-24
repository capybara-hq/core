"use client";

import {
  type ActionRowProps,
  Badge,
  CheckList,
  Field,
  type FieldShape,
  Input,
  ItemList,
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
  type ConnectorInstallInput,
  chosenByDefault,
  descriptionOf,
  displayNameOf,
  endpointLeaves,
  getPath,
  hasChooseStep,
  isOAuth,
  keptTemplates,
  type OrgCatalogDetail,
  type OrgCatalogTemplate,
  type OrgInstallBody,
  setOrgPluginSwitch,
  setPath,
  showValue,
} from "../lib/catalog";
import type { AuthType, ConnectorAuth } from "../lib/connectors";
import type { OrgExtension } from "../lib/extensions";
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
import { TemplateGuideSection } from "./ConnectorGuides";
import { FormError } from "./form-error";
import { usePagePath } from "./shell/path";

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

// `installTemplates`: the templates the wizard asks for by default (the choose step may change
// that); the helper lives in lib/catalog so the route table's server-side prefetch uses the same
// filter (a "use client" module cannot be called from there).
export { installTemplates } from "../lib/catalog";

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
 * manual client, a credential for static auth (the org's; for a personal template the installer's
 * own, which lists the tools and is stored as their personal credential); undefined when complete.
 * `personalCredential: false` keeps a personal template optional (an upgrade whose template's
 * credentials changed on an existing connector: members keep giving their own).
 */
export function missingInput(
  t: OrgCatalogTemplate,
  d: TemplateDraft,
  o: { personalCredential?: boolean } = {},
): "client" | "credential" | undefined {
  const auth = t.auth;
  if (needsClient(auth)) return d.client.clientId.trim() === "" ? "client" : undefined;
  if (auth.type === "none" || isOAuth(auth)) return undefined;
  if (t.ownership !== "org" && o.personalCredential === false) return undefined;
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
    !isOAuth(auth) && auth.type !== "none"
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

/** A template step's fields while the item is on the way: the name, the endpoint, a credential. */
const LOADING_FIELDS: FieldShape[] = [{}, {}, {}];

/** 向导交给页面放进 WizardPage 的部分（页面文件自己渲染模板，见 check:web-ui 的 web-ui-template）。 */
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
 * The wizard that asks for a plugin's input before switching it on (the page puts `frame` into a
 * WizardPage; the last step calls the plugin's switch with the input): for
 * each of its connector templates, the name, the editable endpoint fields (the rest read-only),
 * credentials or client id / secret; then confirm, listing the
 * components and the dependencies installed with it (they take no input). A failure shows the failed
 * step (and the dependency it failed in) and says the components this install created were rolled
 * back.
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
        primary: { label: t("next"), onSelect: () => {} },
      },
      body: null,
      wizardLoading: { fields: LOADING_FIELDS },
    });
  }
  return (
    <Wizard
      orgId={orgId}
      detail={data.detail}
      orgExtensions={data.extensions ?? []}
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
  // The choose step (shown for more than one template, or a default-off one): the admin picks the
  // templates to switch on, default-on ones (and default-off ones already switched on here)
  // checked. Only the chosen ones get a step and a connector; the others are switched off in the
  // org and stay as template cards on the connectors page. A template whose connector this org
  // already has (a switch-off kept it) is not asked for: the install takes that connector back.
  const choosing = hasChooseStep(detail.templates);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    () => new Set(detail.templates.filter(chosenByDefault).map((c) => c.id)),
  );
  // A template that is kept and on stays as it is (its row is locked on the choose step)
  const locked = new Set(keptTemplates(detail.templates).map((c) => c.id));
  const picked = detail.templates.filter((c) => chosen.has(c.id) || locked.has(c.id));
  const templates = picked.filter((c) => c.connected !== true);
  const kept = picked.filter((c) => c.connected === true);
  const offset = choosing ? 1 : 0;
  const steps = [
    ...(choosing ? [t("chooseStep")] : []),
    ...templates.map((c) => t("connectorStep", { name: templateName(c) })),
    t("confirmStep"),
  ];
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, TemplateDraft>>(() =>
    Object.fromEntries(
      detail.templates.map((c) => [c.id, initialTemplateDraft(c, locale, item.name)]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  // Switching it on (with the input) changes the catalog's view, the installed plugins and what
  // the plugin brings.
  const install = useAppMutation({
    fn: (inputs: OrgInstallBody) => setOrgPluginSwitch(orgId, item.id, { enabled: true, inputs }),
    invalidates: () => pluginChangeKeys(orgId),
  });
  const confirmIdx = steps.length - 1;
  const installable =
    item.state !== "unavailable" && item.state !== "not_offered" && !item.notDeployed;

  const template =
    step >= offset && step - offset < templates.length ? templates[step - offset] : undefined;
  const draft = template ? drafts[template.id] : undefined;
  const setDraft = (next: TemplateDraft) => {
    if (template) setDrafts((d) => ({ ...d, [template.id]: next }));
  };
  // A manual OAuth client and a personal template's own credential are required before going on
  // (an org credential may be left for the kernel to ask for).
  const templateIncomplete =
    template !== undefined &&
    draft !== undefined &&
    (needsClient(template.auth) || template.ownership === "personal") &&
    missingInput(template, draft) !== undefined;

  const submit = async () => {
    setSubmitting(true);
    setError(undefined);
    // no version: an org always installs the platform version (ruling P2-17)
    // With the choose step the kernel switches on exactly the chosen templates (templatesOn)
    const body: OrgInstallBody = {
      ...(templates.length > 0 && {
        connectors: Object.fromEntries(
          templates.map((c) => [c.id, connectorInput(c, drafts[c.id] as TemplateDraft)]),
        ),
      }),
      ...(choosing && { templatesOn: picked.map((c) => c.id) }),
    };
    try {
      await install.mutateAsync(body);
      toast.success(tp("toast.enabled", { name }));
      // An extension that still needs config goes on to its Sheet (the wizard collects none)
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

  const next = () => {
    setStep((s) => Math.min(s + 1, confirmIdx));
  };

  const actionRow = {
    cancel: {
      label: t("cancel"),
      onSelect: () => router.push(`/plugins/${encodeURIComponent(item.id)}`),
    },
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

  // Already on: the kernel's switch would drop the inputs, so the wizard asks for none.
  if (item.state === "on") {
    return frame({
      ...header(t("title", { name })),
      steps: [t("confirmStep")],
      current: 0,
      actionRow: {
        primary: {
          label: t("backToPlugin"),
          onSelect: () => router.push(`/plugins/${encodeURIComponent(item.id)}`),
        },
      },
      body: <Text variant="prose">{t("alreadyOn", { name })}</Text>,
    });
  }

  return frame({
    ...header(t("title", { name })),
    steps,
    current: step,
    actionRow,
    body: (
      <>
        {choosing && step === 0 && (
          <ChooseTemplates
            templates={detail.templates}
            chosen={chosen}
            locked={locked}
            templateName={templateName}
            onCheck={(id, next) =>
              setChosen((cur) => {
                const out = new Set(cur);
                if (next) out.add(id);
                else out.delete(id);
                return out;
              })
            }
          />
        )}
        {/* The template's setup guide above its input (setup guides v2 spec §9.3) */}
        {template !== undefined && <TemplateGuideSection orgId={orgId} template={template} />}
        {template !== undefined && draft !== undefined && (
          <TemplateStep template={template} draft={draft} onChange={setDraft} />
        )}
        {step === confirmIdx && (
          <Stack gap={12}>
            {!installable && <FormError message={t("notInstallable")} />}
            <Text variant="prose">{t("summary")}</Text>
            <Text variant="small" tone="muted">
              {[
                detail.extension !== null
                  ? t("summaryExtension", { name: detail.extension })
                  : null,
                templates.length + kept.length > 0
                  ? t("summaryTemplates", { n: templates.length + kept.length })
                  : null,
                detail.skills.length > 0 ? t("summarySkills", { n: detail.skills.length }) : null,
              ]
                .filter((s) => s !== null)
                .join(" · ")}
            </Text>
            {/* The connector templates with their icons; one the org already has a connector for
                is kept, not asked for again */}
            {templates.length + kept.length > 0 && (
              <ComponentSection
                title={tc("templates")}
                count={templates.length + kept.length}
                empty={tc("templatesNone")}
              >
                <ItemList
                  label={tc("templates")}
                  rows={[...templates, ...kept].map((c) => ({
                    id: c.id,
                    mark: { text: templateName(c), image: c.icon ?? null },
                    title: templateName(c),
                    ...(kept.includes(c) && {
                      meta: t("connectorKept", { name: templateName(c) }),
                    }),
                  }))}
                />
              </ComponentSection>
            )}
            {/* Templates left out on the choose step: switched off, still on the connectors page */}
            {choosing && detail.templates.length > picked.length && (
              <Text variant="small" tone="muted">
                {t("summaryNotChosen", { n: detail.templates.length - picked.length })}
              </Text>
            )}
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

/** What a template's step will ask for, as one short mark on the choose step. */
export type TemplateNeed = "kept" | "client" | "endpoint" | "personal" | "credential" | "none";

/**
 * What choosing a template asks for on its step, the most demanding first: nothing for one whose
 * connector the org keeps; an OAuth client (manual client registration); an address (an editable
 * endpoint field without a preset); the installer's own credential (a personal template); an org
 * credential, which may be left for later; else nothing (no auth, or a client registered
 * automatically, and every endpoint field preset).
 */
export function templateNeed(t: OrgCatalogTemplate): TemplateNeed {
  if (t.connected === true) return "kept";
  if (needsClient(t.auth)) return "client";
  if (endpointFields(t).some((f) => f.editable && showValue(f.preset).trim() === "")) {
    return "endpoint";
  }
  if (t.auth.type === "none" || isOAuth(t.auth)) return "none";
  return t.ownership === "personal" ? "personal" : "credential";
}

/**
 * The choose step: every connector template of the plugin as a checklist row (its icon, name and
 * description in the page's language, a mark saying what its step asks for). Kept templates are
 * locked on; the hint says the unchosen ones stay available on the connectors page.
 */
function ChooseTemplates({
  templates,
  chosen,
  locked,
  templateName,
  onCheck,
}: {
  templates: OrgCatalogTemplate[];
  chosen: ReadonlySet<string>;
  locked: ReadonlySet<string>;
  templateName(c: OrgCatalogTemplate): string;
  onCheck(id: string, next: boolean): void;
}) {
  const t = useTranslations("catalog.org.install");
  const locale = useLocale();
  return (
    <Stack gap={12}>
      <Text variant="prose" tone="muted">
        {t("chooseHint")}
      </Text>
      <CheckList
        label={t("chooseStep")}
        rows={templates.map((c) => {
          const description = descriptionOf(c, locale);
          return {
            id: c.id,
            title: templateName(c),
            mark: { text: templateName(c), image: c.icon ?? null },
            marks: <Badge>{t(`need.${templateNeed(c)}`)}</Badge>,
            ...(description !== "" && { description }),
            checked: locked.has(c.id) || chosen.has(c.id),
            ...(locked.has(c.id) && { locked: true }),
          };
        })}
        onCheck={onCheck}
      />
    </Stack>
  );
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
          <Text variant="prose" tone="muted">
            {t("noneHint")}
          </Text>
        ) : oauth ? (
          needsClient(auth) ? (
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
        ) : template.ownership === "personal" && credentialsOnly ? (
          <Text variant="prose" tone="muted">
            {t("personalMembersHint")}
          </Text>
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
