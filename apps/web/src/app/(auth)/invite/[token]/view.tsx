"use client";

import {
  AuthPage,
  Button,
  DateTime,
  Field,
  Input,
  KeyValue,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { FormError } from "../../../../components/form-error";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import {
  acceptInvitation,
  type InvitationPreview,
  invitePath,
  type SignupInput,
} from "../../../../lib/members";
import { usePreferences } from "../../../../lib/preferences";
import { setCurrentOrg } from "../../../../lib/session";
import { broadcastSession } from "../../../../lib/session-sync";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** A kernel refusal, as the server passes it (an error object does not cross to the browser). */
export type Problem = { status: number; code: string; message: string };

/** What the server read: the preview and whether there is a valid session, or the refusal. */
export type InviteInitial =
  | { kind: "ready"; invite: InvitationPreview; signedIn: boolean }
  | { kind: "error"; problem: Problem };

type State =
  | { kind: "ready"; invite: InvitationPreview; signedIn: boolean }
  | { kind: "error"; error: unknown };

/** 会话缺失 / 失效（apiFetch 已试过一次 refresh）。 */
const unauthenticated = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/** 令牌本身不可用（无效 / 撤销、过期、已使用）：整页显示失效。 */
const deadLink = (e: unknown) =>
  e instanceof ApiClientError &&
  ["invitation.invalid", "invitation.expired", "invitation.used"].includes(e.code);

/**
 * `/invite/[token]`: accept an org invitation (AuthPage). The server read the public preview (org
 * name, role, expiry) and whether there is a session: signed in → "Accept"; signed out → "Sign in
 * to accept" (sign-in comes back here), or create an account and join. Accepting switches to the
 * org and loads home as a new document; the other tabs are told first (a sign-up signs in, an accept switches the
 * org). The token is single-use and time-limited; the kernel decides and rate-limits.
 */
export default function InviteView({ token, initial }: { token: string; initial: InviteInitial }) {
  const t = useTranslations("invite");
  const tm = useTranslations("members");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const [state, setState] = useState<State>(() =>
    initial.kind === "ready"
      ? initial
      : {
          kind: "error",
          error: new ApiClientError(
            initial.problem.status,
            initial.problem.code,
            initial.problem.message,
          ),
        },
  );
  const [signup, setSignup] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const here = invitePath(token);

  async function accept(input?: SignupInput) {
    setPending(true);
    setActionError(undefined);
    try {
      const { orgId } = await acceptInvitation(token, input);
      // Enter the org just joined; a failed switch does not undo the join (home can pick it)
      await setCurrentOrg(orgId).catch(() => {});
      // A sign-up signed in; an accept switched the org: the other tabs follow (spec §3.2)
      broadcastSession(input === undefined ? "org-switched" : "signed-in");
      // A new session or org: load the new document (ruling R4); the button stays pending until then.
      navigateBrowser("/");
    } catch (e) {
      setPending(false);
      if (deadLink(e)) setState({ kind: "error", error: e });
      else if (input === undefined && unauthenticated(e)) router.push(loginPathFor(here));
      else setActionError(errorMessage(e));
    }
  }

  const preferences = usePreferences();
  if (state.kind === "error") {
    const dead = deadLink(state.error);
    return (
      <AuthPage title={dead ? t("invalidTitle") : t("title")} preferences={preferences}>
        <Stack gap={16}>
          <FormError message={errorMessage(state.error)} />
          {dead && (
            <Text variant="prose" tone="muted">
              {t("invalidHint")}
            </Text>
          )}
          <Button density="prominent" onClick={() => router.replace("/")}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  const { invite, signedIn } = state;
  return (
    <AuthPage
      title={t("title")}
      subtitle={t("subtitle", { org: invite.org.name })}
      preferences={preferences}
    >
      <Stack gap={16}>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("role"), v: tm(`roles.${invite.role}`) },
            {
              k: t("expires"),
              v: <DateTime value={invite.expiresAt} />,
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
            <Text variant="prose" tone="muted">
              {t("signInHint")}
            </Text>
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
