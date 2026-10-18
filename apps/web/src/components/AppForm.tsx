"use client";

import { Field, Input } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { AppAuth, AuthType, CredentialValue, OAuthClientValue } from "../lib/apps";

export const AUTH_TYPES = [
  "none",
  "bearer",
  "api_key",
  "basic",
  "headers",
] as const satisfies readonly AuthType[];

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
    // Basic 认证用户名与密码缺一不可
    return values.username === "" || values.password === ""
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

/** OAuth 客户端的输入值（未裁剪）。 */
export type OAuthClientDraft = { clientId: string; clientSecret: string };

export const EMPTY_OAUTH_CLIENT: OAuthClientDraft = { clientId: "", clientSecret: "" };

/** 客户端草稿 → 请求值；没填 client id 时为 undefined。密钥留空即不带。 */
export function buildOAuthClient(draft: OAuthClientDraft): OAuthClientValue | undefined {
  const clientId = draft.clientId.trim();
  if (clientId === "") return undefined;
  return draft.clientSecret === "" ? { clientId } : { clientId, clientSecret: draft.clientSecret };
}

/** OAuth 客户端字段（安装向导与凭据页轮换共用）：client id 与密码型的 client secret。 */
export function OAuthClientFields({
  values,
  onChange,
  secretRequired,
  errors = {},
}: {
  values: OAuthClientDraft;
  onChange(next: OAuthClientDraft): void;
  secretRequired: boolean;
  errors?: { clientId?: string; clientSecret?: string };
}) {
  const t = useTranslations("apps.oauth");
  return (
    <>
      <Field
        label={t("clientIdLabel")}
        required
        {...(errors.clientId !== undefined ? { error: errors.clientId } : {})}
      >
        <Input
          autoComplete="off"
          value={values.clientId}
          onChange={(e) => onChange({ ...values, clientId: e.target.value })}
        />
      </Field>
      <Field
        label={t("clientSecretLabel")}
        {...(secretRequired ? { required: true } : { optional: true, help: t("clientSecretHelp") })}
        {...(errors.clientSecret !== undefined ? { error: errors.clientSecret } : {})}
      >
        <Input
          type="password"
          autoComplete="off"
          value={values.clientSecret}
          onChange={(e) => onChange({ ...values, clientSecret: e.target.value })}
        />
      </Field>
    </>
  );
}
