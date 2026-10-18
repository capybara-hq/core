"use client";

import {
  Card,
  Field,
  FormSection,
  Input,
  Select,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ApiClientError } from "../lib/api";
import {
  type AppAuth,
  type AppDetail,
  type AuthType,
  type CredentialValue,
  createApp,
  type Ownership,
  type ToolIssue,
} from "../lib/apps";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

export const AUTH_TYPES = [
  "none",
  "bearer",
  "api_key",
  "basic",
  "headers",
] as const satisfies readonly AuthType[];
const NAME_MAX = 80;
const SLUG_MAX = 24;

/** 每行一个、去空白与空行的请求头名。 */
const headerNames = (raw: string) =>
  raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** 认证方式（不含凭据值）。 */
function buildAuth(
  type: AuthType,
  ownership: Ownership,
  keyIn: "header" | "query",
  keyName: string,
  names: string[],
): AppAuth {
  switch (type) {
    case "none":
      return { type };
    case "api_key":
      return { type, ownership, in: keyIn, name: keyName.trim() };
    case "headers":
      return { type, ownership, names };
    default:
      return { type, ownership };
  }
}

/** 认证方式对应的凭据值；一项都没填时为 undefined（不提交，之后在凭据页设置）。 */
export function buildCredential(
  type: AuthType,
  values: { token: string; username: string; password: string; headers: Record<string, string> },
  names: string[],
): CredentialValue | undefined {
  if (type === "bearer" || type === "api_key") {
    return values.token === "" ? undefined : { token: values.token };
  }
  if (type === "basic") {
    return values.username === "" && values.password === ""
      ? undefined
      : { username: values.username, password: values.password };
  }
  if (type === "headers") {
    const headers = Object.fromEntries(names.map((n) => [n, values.headers[n] ?? ""]));
    return Object.values(headers).every((v) => v === "") ? undefined : { headers };
  }
  return undefined;
}

/** 凭据字段（新建表单与凭据页共用）：按认证方式渲染令牌 / 用户名 + 密码 / 各请求头的值。 */
export function CredentialFields({
  auth,
  values,
  onChange,
}: {
  auth: AppAuth;
  values: { token: string; username: string; password: string; headers: Record<string, string> };
  onChange(next: {
    token: string;
    username: string;
    password: string;
    headers: Record<string, string>;
  }): void;
}) {
  const t = useTranslations("apps.form");
  if (auth.type === "bearer" || auth.type === "api_key") {
    return (
      <Field label={t("tokenLabel")}>
        <Input
          type="password"
          autoComplete="off"
          value={values.token}
          onChange={(e) => onChange({ ...values, token: e.target.value })}
        />
      </Field>
    );
  }
  if (auth.type === "basic") {
    return (
      <>
        <Field label={t("usernameLabel")}>
          <Input
            autoComplete="off"
            value={values.username}
            onChange={(e) => onChange({ ...values, username: e.target.value })}
          />
        </Field>
        <Field label={t("passwordLabel")}>
          <Input
            type="password"
            autoComplete="off"
            value={values.password}
            onChange={(e) => onChange({ ...values, password: e.target.value })}
          />
        </Field>
      </>
    );
  }
  if (auth.type === "headers") {
    return auth.names.map((n) => (
      <Field key={n} label={t("headerValueLabel", { name: n })}>
        <Input
          type="password"
          autoComplete="off"
          value={values.headers[n] ?? ""}
          onChange={(e) =>
            onChange({ ...values, headers: { ...values.headers, [n]: e.target.value } })
          }
        />
      </Field>
    ));
  }
  return null;
}

export const EMPTY_CREDENTIAL = { token: "", username: "", password: "", headers: {} };

/** {@link useAppForm} 的结果：页面把它们放进 FormPage。 */
export type AppFormView = {
  anchors: { id: string; label: string; error?: boolean }[];
  sections: ReactNode;
  unsaved: number;
  errors: number;
  /** 已安装但有工具被停用：主操作改为「继续」。 */
  installed: AppDetail | undefined;
  submit(): void;
  pending: boolean;
};

/**
 * 安装应用的表单（第一段只支持 MCP + 静态认证）：名称、slug（可选）、端点 URL、认证方式与归属、
 * 可选的凭据值。安装成功且没有问题工具时调用 `onDone(app)`；有工具被停用时列出原因，由用户点「继续」。
 */
export function useAppForm(orgId: string, onDone: (app: AppDetail) => void): AppFormView {
  const t = useTranslations("apps");
  const errorMessage = useErrorMessage();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [ownership, setOwnership] = useState<Ownership>("org");
  const [keyIn, setKeyIn] = useState<"header" | "query">("header");
  const [keyName, setKeyName] = useState("");
  const [namesRaw, setNamesRaw] = useState("");
  const [credential, setCredential] = useState(EMPTY_CREDENTIAL);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [details, setDetails] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);
  const [urlError, setUrlError] = useState(false);
  const [installed, setInstalled] = useState<{ app: AppDetail; issues: ToolIssue[] }>();

  const names = headerNames(namesRaw);
  const auth = buildAuth(authType, ownership, keyIn, keyName, names);

  async function save() {
    if (pending || installed !== undefined) return;
    const n = name.trim();
    const u = url.trim();
    setNameError(n === "");
    setUrlError(u === "");
    if (n === "" || u === "") return;
    const cred = buildCredential(authType, credential, names);
    setPending(true);
    setError(undefined);
    setDetails([]);
    try {
      const res = await createApp(orgId, {
        name: n,
        ...(slug.trim() !== "" ? { slug: slug.trim() } : {}),
        connector: "mcp",
        endpoint: { url: u },
        auth,
        ...(cred !== undefined ? { credential: cred } : {}),
      });
      if (res.issues.length === 0) onDone(res.app);
      else setInstalled(res);
    } catch (e) {
      setError(errorMessage(e));
      if (e instanceof ApiClientError) {
        setDetails(e.details.map((d) => (d.path === "" ? d.message : `${d.path}: ${d.message}`)));
      }
    } finally {
      setPending(false);
    }
  }

  const errors = (nameError ? 1 : 0) + (urlError ? 1 : 0);
  const unsaved =
    installed !== undefined
      ? 0
      : [name.trim() !== "", slug !== "", url !== "", authType !== "none"].filter(Boolean).length;

  const anchors: AppFormView["anchors"] = [
    { id: "basic", label: t("form.basicSection"), error: nameError },
    { id: "connection", label: t("form.connectionSection"), error: urlError },
    { id: "auth", label: t("form.authSection") },
  ];

  const sections = (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <Stack gap={16}>
        {installed !== undefined && (
          <Card tone="danger" title={t("form.issuesTitle")}>
            <Stack gap={4}>
              {installed.issues.map((i) => (
                <Text key={i.name} tone="warn">{`‖ ${i.name}: ${i.reason}`}</Text>
              ))}
            </Stack>
          </Card>
        )}
        {error !== undefined && <FormError message={error} extra={details} />}
        <div>
          <FormSection
            id="basic"
            title={t("form.basicSection")}
            description={t("form.basicSectionHint")}
          >
            <Field
              label={t("form.nameLabel")}
              required
              count={{ value: name.length, max: NAME_MAX }}
              {...(nameError ? { error: t("form.nameRequired") } : {})}
            >
              <Input
                name="name"
                maxLength={NAME_MAX}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (e.target.value.trim() !== "") setNameError(false);
                }}
              />
            </Field>
            <Field label={t("form.slugLabel")} optional help={t("form.slugHelp")}>
              <Input
                name="slug"
                maxLength={SLUG_MAX}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </Field>
          </FormSection>
          <FormSection
            id="connection"
            title={t("form.connectionSection")}
            description={t("form.connectionSectionHint")}
          >
            <Field
              label={t("form.urlLabel")}
              required
              help={t("form.urlHelp")}
              {...(urlError ? { error: t("form.urlRequired") } : {})}
            >
              <Input
                name="url"
                type="url"
                placeholder="https://"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  if (e.target.value.trim() !== "") setUrlError(false);
                }}
              />
            </Field>
          </FormSection>
          <FormSection
            id="auth"
            title={t("form.authSection")}
            description={t("form.authSectionHint")}
          >
            <Field label={t("form.authTypeLabel")}>
              <Select
                name="authType"
                value={authType}
                onChange={(e) => {
                  setAuthType(e.target.value as AuthType);
                  setCredential(EMPTY_CREDENTIAL);
                }}
                options={AUTH_TYPES.map((a) => ({ value: a, label: t(`auth.${a}`) }))}
              />
            </Field>
            {authType !== "none" && (
              <Field label={t("form.ownershipLabel")} help={t(`form.ownershipHelp.${ownership}`)}>
                <Select
                  name="ownership"
                  value={ownership}
                  onChange={(e) => setOwnership(e.target.value as Ownership)}
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
                    name="keyIn"
                    value={keyIn}
                    onChange={(e) => setKeyIn(e.target.value as "header" | "query")}
                    options={(["header", "query"] as const).map((o) => ({
                      value: o,
                      label: t(`form.keyIn.${o}`),
                    }))}
                  />
                </Field>
                <Field label={t("form.keyNameLabel")}>
                  <Input
                    name="keyName"
                    value={keyName}
                    onChange={(e) => setKeyName(e.target.value)}
                  />
                </Field>
              </>
            )}
            {authType === "headers" && (
              <Field label={t("form.headerNamesLabel")} help={t("form.headerNamesHelp")}>
                <Textarea
                  code
                  name="headerNames"
                  rows={3}
                  value={namesRaw}
                  onChange={(e) => setNamesRaw(e.target.value)}
                />
              </Field>
            )}
            {authType !== "none" && (
              <Stack gap={8}>
                <Text variant="small" tone="muted">
                  {t(`form.credentialHint.${ownership}`)}
                </Text>
                <CredentialFields auth={auth} values={credential} onChange={setCredential} />
              </Stack>
            )}
          </FormSection>
        </div>
      </Stack>
    </form>
  );

  return {
    anchors,
    sections,
    unsaved,
    errors,
    installed: installed?.app,
    submit: () => void save(),
    pending,
  };
}
