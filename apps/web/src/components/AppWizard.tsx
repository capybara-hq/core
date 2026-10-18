"use client";

import {
  type ActionRowProps,
  Button,
  Card,
  type Column,
  DataTable,
  Field,
  Input,
  RadioGroup,
  Select,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { useRouter } from "../i18n/navigation";
import { ApiClientError } from "../lib/api";
import {
  type AppAuth,
  type AppDetail,
  type AppEndpoint,
  type AppPreview,
  type AuthHint,
  type AuthType,
  type ConnectorKind,
  type ConnectorOperation,
  type CredentialValue,
  createApp,
  type Ownership,
  previewApp,
  type TokenAuthMethod,
  type ToolIssue,
  type ToolPolicy,
  type ToolPreview,
} from "../lib/apps";
import { useErrorMessage } from "../lib/use-error-message";
import {
  AUTH_TYPES,
  buildCredential,
  buildOAuthClient,
  CredentialFields,
  EMPTY_CREDENTIAL,
  EMPTY_OAUTH_CLIENT,
  OAuthClientFields,
} from "./AppForm";
import { connectionHref } from "./ConnectCard";
import { FormError } from "./form-error";

/** 向导步骤：端点类型 → 端点与文档 → 认证 → 工具与默认策略 → 完成。 */
export const WIZARD_STEPS = ["type", "endpoint", "auth", "tools", "done"] as const;
const [TYPE, ENDPOINT, AUTH, TOOLS, DONE] = [0, 1, 2, 3, 4];

const NAME_MAX = 80;
const SLUG_MAX = 24;
/** 上传的 OpenAPI 文档上限（与连接器一致）。 */
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;

/** 向导里可选的全部认证方式（静态 + OAuth）。 */
const WIZARD_AUTH_TYPES = [...AUTH_TYPES, "oauth_code", "oauth_client"] as const;
type WizardAuthType = (typeof WIZARD_AUTH_TYPES)[number];

type OAuthDraft = {
  discovery: "mcp" | "manual";
  authorizationUrl: string;
  tokenUrl: string;
  /** 空格分隔。 */
  scopes: string;
  client: "dcr" | "manual";
  tokenAuthMethod: "" | TokenAuthMethod;
};

const oauthDefaults = (connector: ConnectorKind): OAuthDraft => ({
  discovery: connector === "mcp" ? "mcp" : "manual",
  authorizationUrl: "",
  tokenUrl: "",
  scopes: "",
  client: connector === "mcp" ? "dcr" : "manual",
  tokenAuthMethod: "",
});

/** 每行一个、去空白与空行的请求头名。 */
const headerNames = (raw: string) =>
  raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");

const scopeList = (raw: string) => raw.split(/\s+/).filter((s) => s !== "");

/**
 * OpenAPI 操作的默认策略（与连接器的注解、内核的推导一致）：GET / HEAD 只读 → 允许；DELETE 有破坏性 → 需审批；
 * 其余没有注解 → 需审批。
 */
export function operationPolicy(method: string): {
  policy: ToolPolicy;
  hint: "readOnly" | "destructive" | "none";
} {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return { policy: "allow", hint: "readOnly" };
  if (m === "DELETE") return { policy: "ask", hint: "destructive" };
  return { policy: "ask", hint: "none" };
}

const annotationHint = (t: ToolPreview): "readOnly" | "destructive" | "none" =>
  t.annotations?.readOnlyHint === true
    ? "readOnly"
    : t.annotations?.destructiveHint === true
      ? "destructive"
      : "none";

type WizardError = { message: string; extra: string[] };

/** {@link useAppWizard} 的结果：页面把它们放进 WizardPage。 */
export type AppWizardView = {
  steps: string[];
  current: number;
  actionRow: ActionRowProps;
  body: ReactNode;
};

/**
 * 安装应用的向导（MCP 或 OpenAPI）。端点一步用预览（不落库）读出认证提示与操作清单并预填认证；
 * 认证一步再预览一次验证凭据并列出工具；工具一步勾选 OpenAPI 操作、查看默认策略后安装。
 * 安装失败时：OAuth 服务不支持自动注册客户端（`dcr_unsupported`）→ 回到认证一步改为手填客户端；
 * 未配置 `http.publicUrl` → 说明原因。
 */
export function useAppWizard(orgId: string): AppWizardView {
  const t = useTranslations("apps");
  const tc = useTranslations("common");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [step, setStep] = useState(TYPE);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<WizardError>();
  const [notice, setNotice] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 1. 端点类型
  const [connector, setConnector] = useState<ConnectorKind>("mcp");
  // 2. 端点与文档
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [specSource, setSpecSource] = useState<"url" | "file">("url");
  const [specUrl, setSpecUrl] = useState("");
  const [specFile, setSpecFile] = useState<{ name: string; text: string }>();
  const [baseUrl, setBaseUrl] = useState("");
  const [inspected, setInspected] = useState<AppPreview>();
  // 3. 认证
  const [authType, setAuthType] = useState<WizardAuthType>("none");
  const [authTouched, setAuthTouched] = useState(false);
  const [hintChoice, setHintChoice] = useState("custom");
  const [ownership, setOwnership] = useState<Ownership>("org");
  const [keyIn, setKeyIn] = useState<"header" | "query">("header");
  const [keyName, setKeyName] = useState("");
  const [namesRaw, setNamesRaw] = useState("");
  const [credential, setCredential] = useState(EMPTY_CREDENTIAL);
  const [oauth, setOAuth] = useState<OAuthDraft>(() => oauthDefaults("mcp"));
  const [client, setClient] = useState(EMPTY_OAUTH_CLIENT);
  // 4. 工具
  const [tools, setTools] = useState<AppPreview>();
  const [selectedOps, setSelectedOps] = useState<Set<string>>(new Set());
  // 5. 完成
  const [installed, setInstalled] = useState<{ app: AppDetail; issues: ToolIssue[] }>();

  const names = headerNames(namesRaw);
  const operations = inspected?.operations;

  function endpoint(withOperations: boolean): AppEndpoint {
    if (connector === "mcp") return { url: url.trim() };
    const ops =
      withOperations && operations !== undefined && selectedOps.size < operations.length
        ? operations.filter((o) => selectedOps.has(o.id)).map((o) => o.id)
        : undefined;
    return {
      ...(specSource === "url" ? { specUrl: specUrl.trim() } : { specText: specFile?.text ?? "" }),
      ...(baseUrl.trim() !== "" ? { baseUrl: baseUrl.trim() } : {}),
      ...(ops !== undefined ? { operations: ops } : {}),
    };
  }

  function auth(): AppAuth {
    const scopes = scopeList(oauth.scopes);
    const method = oauth.tokenAuthMethod === "" ? {} : { tokenAuthMethod: oauth.tokenAuthMethod };
    switch (authType) {
      case "none":
        return { type: "none" };
      case "api_key":
        return { type: "api_key", ownership, in: keyIn, name: keyName.trim() };
      case "headers":
        return { type: "headers", ownership, names };
      case "oauth_code":
        return {
          type: "oauth_code",
          ownership: "personal",
          discovery: oauth.discovery,
          ...(oauth.discovery === "manual"
            ? { authorizationUrl: oauth.authorizationUrl.trim(), tokenUrl: oauth.tokenUrl.trim() }
            : {}),
          ...(scopes.length > 0 ? { scopes } : {}),
          client: oauth.client,
          ...(oauth.client === "manual" && client.clientSecret !== "" ? method : {}),
        };
      case "oauth_client":
        return {
          type: "oauth_client",
          ownership: "org",
          tokenUrl: oauth.tokenUrl.trim(),
          ...(scopes.length > 0 ? { scopes } : {}),
          ...method,
        };
      default:
        return { type: authType, ownership };
    }
  }

  function credentialValue(): CredentialValue | undefined {
    if (authType === "oauth_client") return buildOAuthClient(client);
    if (authType === "oauth_code") {
      return oauth.client === "manual" ? buildOAuthClient(client) : undefined;
    }
    return buildCredential(authType as AuthType, credential, names);
  }

  /** 按提示预填认证（来自远端描述）。 */
  function applyHint(h: AuthHint) {
    setAuthType(h.type);
    setCredential(EMPTY_CREDENTIAL);
    if (h.type === "api_key") {
      setKeyIn(h.in);
      setKeyName(h.name);
    }
    if (h.type === "oauth_client") {
      setOAuth({ ...oauthDefaults(connector), tokenUrl: h.tokenUrl, scopes: h.scopes.join(" ") });
    }
    if (h.type === "oauth_code") {
      setOAuth({
        ...oauthDefaults(connector),
        discovery: "manual",
        client: "manual",
        authorizationUrl: h.authorizationUrl,
        tokenUrl: h.tokenUrl,
        scopes: h.scopes.join(" "),
      });
    }
  }

  function fail(e: unknown) {
    const extra: string[] = [];
    if (e instanceof ApiClientError) {
      for (const d of e.details) extra.push(d.path === "" ? d.message : `${d.path}: ${d.message}`);
      // 连接失败的说明（内核已打码）：没有明细时就是消息本身
      if (e.code === "app.connect_failed" && e.details.length === 0 && e.message !== e.code) {
        extra.push(e.message);
      }
    }
    setError({ message: errorMessage(e), extra });
  }

  /** OAuth 应用要求内核配置 `http.publicUrl`（回调地址），没配时 400 落在 `auth` 上。 */
  const publicUrlMissing = (e: unknown) =>
    e instanceof ApiClientError &&
    e.code === "validation_failed" &&
    e.details.some((d) => d.path === "auth" && /publicUrl/.test(d.message));

  function validateEndpoint(): boolean {
    const errs: Record<string, string> = {};
    if (name.trim() === "") errs.name = t("form.nameRequired");
    if (connector === "mcp" && url.trim() === "") errs.url = t("form.urlRequired");
    if (connector === "openapi" && specSource === "url" && specUrl.trim() === "") {
      errs.specUrl = t("wizard.specUrlRequired");
    }
    if (connector === "openapi" && specSource === "file" && specFile === undefined) {
      errs.specFile = fieldErrors.specFile ?? t("wizard.specFileRequired");
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function validateAuth(): boolean {
    const errs: Record<string, string> = {};
    const required = t("wizard.required");
    if (authType === "api_key" && keyName.trim() === "") errs.keyName = required;
    if (authType === "headers" && names.length === 0) errs.headerNames = required;
    if (authType === "oauth_code" && oauth.discovery === "manual") {
      if (oauth.authorizationUrl.trim() === "") errs.authorizationUrl = required;
      if (oauth.tokenUrl.trim() === "") errs.tokenUrl = required;
    }
    if (authType === "oauth_client" && oauth.tokenUrl.trim() === "") errs.tokenUrl = required;
    const needsClient =
      authType === "oauth_client" || (authType === "oauth_code" && oauth.client === "manual");
    if (needsClient && client.clientId.trim() === "") errs.clientId = required;
    if (authType === "oauth_client" && client.clientSecret === "") errs.clientSecret = required;
    // 静态认证安装时要用凭据列出工具（没有会 409 credential.missing）
    if (
      authType !== "oauth_code" &&
      authType !== "oauth_client" &&
      authType !== "none" &&
      buildCredential(authType, credential, names) === undefined
    ) {
      errs.credential = t("wizard.credentialRequired");
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function run(fn: () => Promise<void>) {
    setPending(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setPending(false);
    }
  }

  /** 端点 → 认证：预览（只给端点）读认证提示与操作清单。 */
  const inspect = () =>
    run(async () => {
      const res = await previewApp(orgId, {
        name: name.trim(),
        ...(slug.trim() !== "" ? { slug: slug.trim() } : {}),
        connector,
        endpoint: endpoint(false),
      });
      setInspected(res);
      if (!authTouched && res.authHints[0] !== undefined) {
        applyHint(res.authHints[0]);
        setHintChoice("0");
      }
      setSelectedOps(new Set((res.operations ?? []).map((o) => o.id)));
      setNotice(undefined);
      setStep(AUTH);
    });

  /** 认证 → 工具：带认证与凭据再预览（验证凭据并列出工具）。 */
  const listTools = () =>
    run(async () => {
      const cred = authType === "oauth_code" ? undefined : credentialValue();
      try {
        const res = await previewApp(orgId, {
          name: name.trim(),
          ...(slug.trim() !== "" ? { slug: slug.trim() } : {}),
          connector,
          endpoint: endpoint(false),
          auth: auth(),
          ...(cred !== undefined ? { credential: cred } : {}),
        });
        setTools(res);
        setNotice(undefined);
        setStep(TOOLS);
      } catch (e) {
        if (publicUrlMissing(e)) {
          setError({ message: t("wizard.publicUrlRequired"), extra: [] });
          return;
        }
        throw e;
      }
    });

  /** 工具 → 完成：安装。 */
  const install = () =>
    run(async () => {
      const cred = credentialValue();
      try {
        const res = await createApp(orgId, {
          name: name.trim(),
          ...(slug.trim() !== "" ? { slug: slug.trim() } : {}),
          connector,
          endpoint: endpoint(true),
          auth: auth(),
          ...(cred !== undefined ? { credential: cred } : {}),
        });
        setInstalled(res);
        setStep(DONE);
      } catch (e) {
        if (
          e instanceof ApiClientError &&
          e.code === "app.connect_failed" &&
          e.details.some((d) => d.reason === "dcr_unsupported")
        ) {
          // 授权服务器不支持动态注册：回到认证一步改为手填客户端
          setOAuth((o) => ({ ...o, client: "manual" }));
          setNotice(t("wizard.dcrUnsupported"));
          setStep(AUTH);
          return;
        }
        if (publicUrlMissing(e)) {
          setError({ message: t("wizard.publicUrlRequired"), extra: [] });
          return;
        }
        throw e;
      }
    });

  function next() {
    if (pending) return;
    if (step === TYPE) {
      setError(undefined);
      setStep(ENDPOINT);
    } else if (step === ENDPOINT) {
      if (validateEndpoint()) void inspect();
    } else if (step === AUTH) {
      if (validateAuth()) void listTools();
    } else if (step === TOOLS) {
      void install();
    } else if (installed) {
      router.push(`/apps/${encodeURIComponent(installed.app.id)}`);
    }
  }

  function previous() {
    setError(undefined);
    setFieldErrors({});
    setStep((s) => Math.max(TYPE, s - 1));
  }

  const noOps =
    connector === "openapi" &&
    operations !== undefined &&
    operations.length > 0 &&
    selectedOps.size === 0;
  const primaryLabel =
    step === TOOLS ? t("wizard.install") : step === DONE ? t("wizard.openApp") : t("wizard.next");
  const actionRow: ActionRowProps = {
    errors: Object.keys(fieldErrors).length,
    ...(step !== DONE
      ? { cancel: { label: tc("cancel"), onSelect: () => router.push("/apps") } }
      : {}),
    ...(step > TYPE && step < DONE
      ? { secondary: { label: t("wizard.previous"), onSelect: previous, disabled: pending } }
      : {}),
    primary: {
      label: primaryLabel,
      onSelect: next,
      loading: pending,
      ...(step === TOOLS && noOps ? { disabled: true } : {}),
    },
  };

  const clearField = (k: string) =>
    setFieldErrors((f) => {
      if (!(k in f)) return f;
      const { [k]: _, ...rest } = f;
      return rest;
    });
  const errorOf = (k: string) =>
    fieldErrors[k] !== undefined ? { error: fieldErrors[k] as string } : {};

  async function pickFile(file: File | undefined) {
    setSpecFile(undefined);
    if (file === undefined) return;
    if (file.size > MAX_SPEC_BYTES) {
      setFieldErrors((f) => ({ ...f, specFile: t("wizard.specTooLarge") }));
      return;
    }
    clearField("specFile");
    setSpecFile({ name: file.name, text: await file.text() });
  }

  let content: ReactNode;
  if (step === TYPE) {
    content = (
      <Card title={t("wizard.typeTitle")}>
        <RadioGroup
          label={t("wizard.typeTitle")}
          variant="card"
          value={connector}
          onChange={(v) => {
            const kind = v as ConnectorKind;
            setConnector(kind);
            setInspected(undefined);
            setTools(undefined);
            setOAuth(oauthDefaults(kind));
          }}
          options={(["mcp", "openapi"] as const).map((k) => ({
            value: k,
            label: t(`wizard.connector.${k}`),
            description: t(`wizard.connectorHint.${k}`),
          }))}
        />
      </Card>
    );
  } else if (step === ENDPOINT) {
    content = (
      <Card title={t("wizard.endpointTitle")}>
        <Stack gap={12}>
          <Field
            label={t("form.nameLabel")}
            required
            count={{ value: name.length, max: NAME_MAX }}
            {...errorOf("name")}
          >
            <Input
              maxLength={NAME_MAX}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                clearField("name");
              }}
            />
          </Field>
          <Field label={t("form.slugLabel")} optional help={t("form.slugHelp")}>
            <Input maxLength={SLUG_MAX} value={slug} onChange={(e) => setSlug(e.target.value)} />
          </Field>
          {connector === "mcp" ? (
            <Field label={t("form.urlLabel")} required help={t("form.urlHelp")} {...errorOf("url")}>
              <Input
                type="url"
                placeholder="https://"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  clearField("url");
                }}
              />
            </Field>
          ) : (
            <>
              <RadioGroup
                label={t("wizard.specSourceLabel")}
                value={specSource}
                onChange={(v) => {
                  setSpecSource(v as "url" | "file");
                  setFieldErrors({});
                }}
                options={(["url", "file"] as const).map((k) => ({
                  value: k,
                  label: t(`wizard.specSource.${k}`),
                }))}
              />
              {specSource === "url" ? (
                <Field
                  label={t("wizard.specUrlLabel")}
                  required
                  help={t("wizard.specUrlHelp")}
                  {...errorOf("specUrl")}
                >
                  <Input
                    type="url"
                    placeholder="https://"
                    value={specUrl}
                    onChange={(e) => {
                      setSpecUrl(e.target.value);
                      clearField("specUrl");
                    }}
                  />
                </Field>
              ) : (
                <Field
                  label={t("wizard.specFileLabel")}
                  required
                  help={
                    specFile !== undefined
                      ? t("wizard.specFileChosen", { name: specFile.name })
                      : t("wizard.specFileHelp")
                  }
                  {...errorOf("specFile")}
                >
                  <Input
                    type="file"
                    accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                    onChange={(e) => void pickFile(e.target.files?.[0])}
                  />
                </Field>
              )}
              <Field label={t("wizard.baseUrlLabel")} optional help={t("wizard.baseUrlHelp")}>
                <Input
                  type="url"
                  placeholder="https://"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </Field>
            </>
          )}
        </Stack>
      </Card>
    );
  } else if (step === AUTH) {
    content = (
      <AuthStep
        connector={connector}
        hints={inspected?.authHints ?? []}
        hintChoice={hintChoice}
        onHint={(choice) => {
          setHintChoice(choice);
          setAuthTouched(true);
          const h = inspected?.authHints[Number(choice)];
          if (choice !== "custom" && h !== undefined) applyHint(h);
          setFieldErrors({});
        }}
        authType={authType}
        onAuthType={(v) => {
          setAuthType(v);
          setAuthTouched(true);
          setHintChoice("custom");
          setCredential(EMPTY_CREDENTIAL);
          setFieldErrors({});
        }}
        ownership={ownership}
        onOwnership={setOwnership}
        keyIn={keyIn}
        onKeyIn={setKeyIn}
        keyName={keyName}
        onKeyName={(v) => {
          setKeyName(v);
          clearField("keyName");
        }}
        namesRaw={namesRaw}
        onNamesRaw={(v) => {
          setNamesRaw(v);
          clearField("headerNames");
        }}
        auth={auth()}
        credential={credential}
        onCredential={(v) => {
          setCredential(v);
          clearField("credential");
        }}
        oauth={oauth}
        onOAuth={(o) => {
          setOAuth(o);
          for (const k of ["authorizationUrl", "tokenUrl"]) clearField(k);
        }}
        client={client}
        onClient={(c) => {
          setClient(c);
          clearField("clientId");
          clearField("clientSecret");
        }}
        fieldErrors={fieldErrors}
      />
    );
  } else if (step === TOOLS) {
    content = (
      <ToolsStep
        connector={connector}
        authType={authType}
        operations={operations}
        selected={selectedOps}
        onSelected={setSelectedOps}
        preview={tools}
      />
    );
  } else if (installed) {
    content = <DoneStep app={installed.app} issues={installed.issues} />;
  }

  const body = (
    <Stack gap={16}>
      {notice !== undefined && (
        <Card title={t("wizard.noticeTitle")}>
          <Text tone="warn">{notice}</Text>
        </Card>
      )}
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      {content}
    </Stack>
  );

  return {
    steps: WIZARD_STEPS.map((s) => t(`wizard.steps.${s}`)),
    current: step,
    actionRow,
    body,
  };
}

function AuthStep(props: {
  connector: ConnectorKind;
  hints: AuthHint[];
  hintChoice: string;
  onHint(choice: string): void;
  authType: WizardAuthType;
  onAuthType(v: WizardAuthType): void;
  ownership: Ownership;
  onOwnership(v: Ownership): void;
  keyIn: "header" | "query";
  onKeyIn(v: "header" | "query"): void;
  keyName: string;
  onKeyName(v: string): void;
  namesRaw: string;
  onNamesRaw(v: string): void;
  auth: AppAuth;
  credential: typeof EMPTY_CREDENTIAL;
  onCredential(v: typeof EMPTY_CREDENTIAL): void;
  oauth: OAuthDraft;
  onOAuth(v: OAuthDraft): void;
  client: typeof EMPTY_OAUTH_CLIENT;
  onClient(v: typeof EMPTY_OAUTH_CLIENT): void;
  fieldErrors: Record<string, string>;
}) {
  const t = useTranslations("apps");
  const { authType, oauth, fieldErrors } = props;
  const errorOf = (k: string) =>
    fieldErrors[k] !== undefined ? { error: fieldErrors[k] as string } : {};
  const isStatic = authType !== "oauth_code" && authType !== "oauth_client";
  const selectedHint = props.hints[Number(props.hintChoice)];

  return (
    <Card title={t("wizard.authTitle")}>
      <Stack gap={12}>
        {props.hints.length > 0 && (
          <Field
            label={t("wizard.hintLabel")}
            help={
              props.hintChoice !== "custom" && selectedHint?.description
                ? selectedHint.description
                : t("wizard.hintHelp")
            }
          >
            <Select
              value={props.hintChoice}
              onChange={(e) => props.onHint(e.target.value)}
              options={[
                ...props.hints.map((h, i) => ({
                  value: String(i),
                  label: `${h.scheme} · ${t(`auth.${h.type}`)}`,
                })),
                { value: "custom", label: t("wizard.hintCustom") },
              ]}
            />
          </Field>
        )}
        <Field label={t("form.authTypeLabel")}>
          <Select
            value={authType}
            onChange={(e) => props.onAuthType(e.target.value as WizardAuthType)}
            options={WIZARD_AUTH_TYPES.map((a) => ({ value: a, label: t(`auth.${a}`) }))}
          />
        </Field>
        {isStatic && authType !== "none" && (
          <Field label={t("form.ownershipLabel")} help={t(`form.ownershipHelp.${props.ownership}`)}>
            <Select
              value={props.ownership}
              onChange={(e) => props.onOwnership(e.target.value as Ownership)}
              options={(["org", "personal"] as const).map((o) => ({
                value: o,
                label: t(`ownership.${o}`),
              }))}
            />
          </Field>
        )}
        {authType === "api_key" && (
          <>
            <Field label={t("form.keyInLabel")}>
              <Select
                value={props.keyIn}
                onChange={(e) => props.onKeyIn(e.target.value as "header" | "query")}
                options={(["header", "query"] as const).map((o) => ({
                  value: o,
                  label: t(`form.keyIn.${o}`),
                }))}
              />
            </Field>
            <Field label={t("form.keyNameLabel")} required {...errorOf("keyName")}>
              <Input value={props.keyName} onChange={(e) => props.onKeyName(e.target.value)} />
            </Field>
          </>
        )}
        {authType === "headers" && (
          <Field
            label={t("form.headerNamesLabel")}
            required
            help={t("form.headerNamesHelp")}
            {...errorOf("headerNames")}
          >
            <Textarea
              code
              rows={3}
              value={props.namesRaw}
              onChange={(e) => props.onNamesRaw(e.target.value)}
            />
          </Field>
        )}
        {isStatic && authType !== "none" && (
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t(`wizard.credentialHint.${props.ownership}`)}
            </Text>
            <CredentialFields
              auth={props.auth}
              values={props.credential}
              onChange={props.onCredential}
            />
            {fieldErrors.credential !== undefined && (
              <Text variant="small" tone="fail">{`✗ ${fieldErrors.credential}`}</Text>
            )}
          </Stack>
        )}
        {authType === "oauth_code" && (
          <>
            <Text variant="small" tone="muted">
              {t("wizard.oauthCodeHint")}
            </Text>
            <Field label={t("oauth.discoveryLabel")}>
              <Select
                value={oauth.discovery}
                onChange={(e) => {
                  const discovery = e.target.value as OAuthDraft["discovery"];
                  props.onOAuth({
                    ...oauth,
                    discovery,
                    // 自动注册客户端只能配合 MCP 发现
                    client: discovery === "manual" ? "manual" : oauth.client,
                  });
                }}
                options={(props.connector === "mcp"
                  ? (["mcp", "manual"] as const)
                  : (["manual"] as const)
                ).map((d) => ({ value: d, label: t(`oauth.discovery.${d}`) }))}
              />
            </Field>
            {oauth.discovery === "manual" && (
              <>
                <Field
                  label={t("oauth.authorizationUrlLabel")}
                  required
                  {...errorOf("authorizationUrl")}
                >
                  <Input
                    type="url"
                    placeholder="https://"
                    value={oauth.authorizationUrl}
                    onChange={(e) => props.onOAuth({ ...oauth, authorizationUrl: e.target.value })}
                  />
                </Field>
                <Field label={t("oauth.tokenUrlLabel")} required {...errorOf("tokenUrl")}>
                  <Input
                    type="url"
                    placeholder="https://"
                    value={oauth.tokenUrl}
                    onChange={(e) => props.onOAuth({ ...oauth, tokenUrl: e.target.value })}
                  />
                </Field>
              </>
            )}
            <Field label={t("oauth.scopesLabel")} optional help={t("oauth.scopesHelp")}>
              <Input
                value={oauth.scopes}
                onChange={(e) => props.onOAuth({ ...oauth, scopes: e.target.value })}
              />
            </Field>
            <Field label={t("oauth.clientLabel")}>
              <Select
                value={oauth.client}
                onChange={(e) =>
                  props.onOAuth({ ...oauth, client: e.target.value as OAuthDraft["client"] })
                }
                options={(oauth.discovery === "mcp"
                  ? (["dcr", "manual"] as const)
                  : (["manual"] as const)
                ).map((c) => ({ value: c, label: t(`oauth.client.${c}`) }))}
              />
            </Field>
            {oauth.client === "manual" && (
              <>
                <OAuthClientFields
                  values={props.client}
                  onChange={props.onClient}
                  secretRequired={false}
                  errors={{
                    ...(fieldErrors.clientId !== undefined
                      ? { clientId: fieldErrors.clientId }
                      : {}),
                  }}
                />
                {props.client.clientSecret !== "" && (
                  <TokenAuthMethodField
                    value={oauth.tokenAuthMethod}
                    onChange={(v) => props.onOAuth({ ...oauth, tokenAuthMethod: v })}
                  />
                )}
              </>
            )}
          </>
        )}
        {authType === "oauth_client" && (
          <>
            <Text variant="small" tone="muted">
              {t("wizard.oauthClientHint")}
            </Text>
            <Field label={t("oauth.tokenUrlLabel")} required {...errorOf("tokenUrl")}>
              <Input
                type="url"
                placeholder="https://"
                value={oauth.tokenUrl}
                onChange={(e) => props.onOAuth({ ...oauth, tokenUrl: e.target.value })}
              />
            </Field>
            <Field label={t("oauth.scopesLabel")} optional help={t("oauth.scopesHelp")}>
              <Input
                value={oauth.scopes}
                onChange={(e) => props.onOAuth({ ...oauth, scopes: e.target.value })}
              />
            </Field>
            <OAuthClientFields
              values={props.client}
              onChange={props.onClient}
              secretRequired
              errors={{
                ...(fieldErrors.clientId !== undefined ? { clientId: fieldErrors.clientId } : {}),
                ...(fieldErrors.clientSecret !== undefined
                  ? { clientSecret: fieldErrors.clientSecret }
                  : {}),
              }}
            />
            <TokenAuthMethodField
              value={oauth.tokenAuthMethod}
              onChange={(v) => props.onOAuth({ ...oauth, tokenAuthMethod: v })}
            />
          </>
        )}
      </Stack>
    </Card>
  );
}

function TokenAuthMethodField({
  value,
  onChange,
}: {
  value: OAuthDraft["tokenAuthMethod"];
  onChange(v: OAuthDraft["tokenAuthMethod"]): void;
}) {
  const t = useTranslations("apps.oauth");
  return (
    <Field label={t("tokenAuthMethodLabel")}>
      <Select
        value={value}
        onChange={(e) => onChange(e.target.value as OAuthDraft["tokenAuthMethod"])}
        options={(["", "client_secret_basic", "client_secret_post"] as const).map((m) => ({
          value: m,
          label: t(`tokenAuthMethod.${m === "" ? "auto" : m}`),
        }))}
      />
    </Field>
  );
}

function IssuesCard({ issues }: { issues: ToolIssue[] }) {
  const t = useTranslations("apps");
  if (issues.length === 0) return null;
  return (
    <Card tone="danger" title={t("wizard.issuesTitle")}>
      <Stack gap={4}>
        {issues.map((i) => (
          <Text key={i.name} tone="warn">{`‖ ${i.name}: ${i.reason}`}</Text>
        ))}
      </Stack>
    </Card>
  );
}

function ToolsStep({
  connector,
  authType,
  operations,
  selected,
  onSelected,
  preview,
}: {
  connector: ConnectorKind;
  authType: WizardAuthType;
  operations: ConnectorOperation[] | undefined;
  selected: Set<string>;
  onSelected(next: Set<string>): void;
  preview: AppPreview | undefined;
}) {
  const t = useTranslations("apps");
  const policyCell = (policy: ToolPolicy, hint: "readOnly" | "destructive" | "none") => (
    <Stack gap={0}>
      <Text>{t(`policy.${policy}`)}</Text>
      <Text variant="small" tone="muted">
        {t(`wizard.annotation.${hint}`)}
      </Text>
    </Stack>
  );

  if (connector === "openapi" && operations !== undefined) {
    const columns: Column<ConnectorOperation>[] = [
      {
        key: "operation",
        header: t("wizard.columns.operation"),
        cell: (o) => (
          <Stack gap={0}>
            <Text>{`${o.method} ${o.path}`}</Text>
            <Text variant="small" tone="muted" truncate>
              {o.summary ?? o.id}
            </Text>
          </Stack>
        ),
      },
      {
        key: "policy",
        header: t("tools.columns.policy"),
        width: 200,
        cell: (o) => {
          const p = operationPolicy(o.method);
          return policyCell(p.policy, p.hint);
        },
      },
    ];
    return (
      <Stack gap={12}>
        <Text tone="muted">{t("wizard.operationsHint")}</Text>
        <IssuesCard issues={preview?.issues ?? []} />
        <DataTable<ConnectorOperation>
          label={t("wizard.operationsLabel")}
          columns={columns}
          rows={operations}
          rowKey={(o) => o.id}
          rowLabel={(o) => `${o.method} ${o.path}`}
          selection={{ selected, onChange: onSelected }}
          empty={{ title: t("wizard.noOperations") }}
        />
        {selected.size === 0 && operations.length > 0 && (
          <Text tone="fail">{`✗ ${t("wizard.selectOperation")}`}</Text>
        )}
      </Stack>
    );
  }

  if (preview?.tools == null) {
    return (
      <Card title={t("wizard.toolsTitle")}>
        <Text tone="muted">
          {authType === "oauth_code"
            ? t("wizard.toolsAfterConnect")
            : t("wizard.toolsAfterInstall")}
        </Text>
      </Card>
    );
  }

  const columns: Column<ToolPreview>[] = [
    {
      key: "name",
      header: t("tools.columns.name"),
      cell: (x) => (
        <Stack gap={0}>
          <Text>{x.key}</Text>
          <Text variant="small" tone="muted" truncate>
            {x.issue ?? x.description}
          </Text>
        </Stack>
      ),
    },
    {
      key: "policy",
      header: t("tools.columns.policy"),
      width: 200,
      cell: (x) => policyCell(x.defaultPolicy, annotationHint(x)),
    },
  ];
  return (
    <Stack gap={12}>
      <Text tone="muted">{t("wizard.toolsHint")}</Text>
      <IssuesCard issues={preview.issues} />
      <DataTable<ToolPreview>
        label={t("wizard.toolsTitle")}
        columns={columns}
        rows={preview.tools}
        rowKey={(x) => x.name}
        rowLabel={(x) => x.key}
        empty={{ title: t("tools.empty") }}
      />
    </Stack>
  );
}

function DoneStep({ app, issues }: { app: AppDetail; issues: ToolIssue[] }) {
  const t = useTranslations("apps");
  const router = useRouter();
  const needsConnect =
    app.credential.ownership === "personal" && app.credential.status === "missing";
  return (
    <Stack gap={12}>
      <Card title={t("wizard.doneTitle", { name: app.name })}>
        <Stack gap={8}>
          <Text>{t("wizard.doneTools", { count: app.tools.length })}</Text>
          {app.auth.type === "oauth_code" && <Text tone="muted">{t("wizard.doneOAuthCode")}</Text>}
          {needsConnect && (
            <Stack direction="row">
              {/* 视图里唯一的主操作在 ActionRow */}
              <Button onClick={() => router.push(connectionHref(app.id))}>
                {t("wizard.connectNow")}
              </Button>
            </Stack>
          )}
        </Stack>
      </Card>
      <IssuesCard issues={issues} />
    </Stack>
  );
}
