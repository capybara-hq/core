"use client";

import {
  AuthPage,
  Button,
  Field,
  Input,
  KeyValue,
  Skeleton,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useEffect, useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { LocaleLinks } from "../../../../../components/locale-links";
import { useRouter } from "../../../../../i18n/navigation";
import { ApiClientError } from "../../../../../lib/api";
import { loginPathFor } from "../../../../../lib/auth-sources";
import {
  acceptInvitation,
  type InvitationPreview,
  invitePath,
  previewInvitation,
  type SignupInput,
} from "../../../../../lib/members";
import { getMe, setCurrentOrg } from "../../../../../lib/session";
import { useErrorMessage } from "../../../../../lib/use-error-message";

type State =
  | { kind: "loading" }
  /** `signedIn`：当前有有效会话（否则要先登录或注册）。 */
  | { kind: "ready"; invite: InvitationPreview; signedIn: boolean }
  | { kind: "error"; error: unknown };

/** 会话缺失 / 失效（apiFetch 已试过一次 refresh）。 */
const unauthenticated = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/** 令牌本身不可用（无效 / 撤销、过期、已使用）：整页显示失效。 */
const deadLink = (e: unknown) =>
  e instanceof ApiClientError &&
  ["invitation.invalid", "invitation.expired", "invitation.used"].includes(e.code);

/**
 * `/[locale]/invite/[token]`：接受组织邀请（AuthPage）。先公开预览组织名、角色与有效期；
 * 已登录 → 「接受邀请」；未登录 → 「登录后接受」（登录页带回本页），或直接创建账号并加入。
 * 接受后切到该组织并进入首页。令牌一次性、有时限，由内核判定与限流。
 */
export default function InvitePage() {
  const t = useTranslations("invite");
  const tm = useTranslations("members");
  const locale = useLocale();
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [signup, setSignup] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const here = invitePath(token);

  useEffect(() => {
    let disposed = false;
    Promise.all([
      previewInvitation(token),
      getMe().then(
        () => true,
        (e: unknown) => {
          if (unauthenticated(e)) return false;
          throw e;
        },
      ),
    ]).then(
      ([invite, signedIn]) => {
        if (!disposed) setState({ kind: "ready", invite, signedIn });
      },
      (e: unknown) => {
        if (!disposed) setState({ kind: "error", error: e });
      },
    );
    return () => {
      disposed = true;
    };
  }, [token]);

  async function accept(input?: SignupInput) {
    setPending(true);
    setActionError(undefined);
    try {
      const { orgId } = await acceptInvitation(token, input);
      // 进入刚加入的组织；切换失败不影响已加入（首页可以再选）
      await setCurrentOrg(orgId).catch(() => {});
      router.replace("/");
    } catch (e) {
      if (deadLink(e)) setState({ kind: "error", error: e });
      else if (input === undefined && unauthenticated(e)) router.push(loginPathFor(here));
      else setActionError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const footer = <LocaleLinks />;
  if (state.kind === "loading") {
    return (
      <AuthPage title={t("title")} footer={footer}>
        <Stack gap={12}>
          <Text tone="muted">{t("loading")}</Text>
          <Skeleton rows={3} />
        </Stack>
      </AuthPage>
    );
  }
  if (state.kind === "error") {
    const dead = deadLink(state.error);
    return (
      <AuthPage title={dead ? t("invalidTitle") : t("title")} footer={footer}>
        <Stack gap={16}>
          <FormError message={errorMessage(state.error)} />
          {dead && <Text tone="muted">{t("invalidHint")}</Text>}
          <Button density="prominent" onClick={() => router.replace("/")}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  const { invite, signedIn } = state;
  return (
    <AuthPage title={t("title")} subtitle={t("subtitle", { org: invite.org.name })} footer={footer}>
      <Stack gap={16}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("role"), v: tm(`roles.${invite.role}`) },
            {
              k: t("expires"),
              v: new Date(invite.expiresAt).toLocaleString(locale, {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            },
          ]}
        />
        {actionError !== undefined && <FormError message={actionError} />}
        {signedIn ? (
          <Button
            variant="primary"
            density="prominent"
            loading={pending}
            onClick={() => void accept()}
          >
            {t("accept")}
          </Button>
        ) : signup ? (
          <SignupForm
            pending={pending}
            onSubmit={(input) => void accept(input)}
            onBack={() => {
              setSignup(false);
              setActionError(undefined);
            }}
          />
        ) : (
          <Stack gap={8}>
            <Text tone="muted">{t("signInHint")}</Text>
            <Button
              variant="primary"
              density="prominent"
              onClick={() => router.push(loginPathFor(here))}
            >
              {t("signIn")}
            </Button>
            <Button variant="ghost" density="prominent" onClick={() => setSignup(true)}>
              {t("signupToggle")}
            </Button>
          </Stack>
        )}
      </Stack>
    </AuthPage>
  );
}

/** 凭邀请创建本地账号（成功后内核直接登录并加入组织）。 */
function SignupForm({
  pending,
  onSubmit,
  onBack,
}: {
  pending: boolean;
  onSubmit(input: SignupInput): void;
  onBack(): void;
}) {
  const t = useTranslations("invite");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onSubmit({ login: login.trim(), password, displayName: displayName.trim() });
  }

  return (
    <form onSubmit={submit}>
      <Stack gap={16}>
        <Field label={t("loginLabel")} help={t("loginHint")}>
          <Input
            name="login"
            autoComplete="username"
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </Field>
        <Field label={t("passwordLabel")} help={t("passwordHint")}>
          <Input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t("displayNameLabel")}>
          <Input
            name="displayName"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Stack gap={8}>
          <Button type="submit" variant="primary" density="prominent" loading={pending}>
            {t("signup")}
          </Button>
          <Button variant="ghost" density="prominent" onClick={onBack}>
            {t("backToSignIn")}
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}
