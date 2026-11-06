"use client";

import {
  AuthPage,
  Button,
  DateTime,
  Field,
  type FieldShape,
  Input,
  KeyValue,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { FormError } from "../../../../components/form-error";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import { acceptInvitation, invitePath, type SignupInput } from "../../../../lib/members";
import { usePreferences } from "../../../../lib/preferences";
import { invitationQuery } from "../../../../lib/query/auth";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/mutation";
import { maybeMeQuery } from "../../../../lib/query/shell";
import { resetSession } from "../../../../lib/query/workspace";
import { HOME_PATH } from "../../../../lib/routes";
import { setCurrentOrg } from "../../../../lib/session";
import { broadcastSession } from "../../../../lib/session-sync";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** The session is missing or expired (`apiFetch` already tried one refresh). */
const unauthenticated = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/** The token itself is unusable (invalid or revoked, expired, used): the whole page says so. */
const deadLink = (e: unknown) =>
  e instanceof ApiClientError &&
  ["invitation.invalid", "invitation.expired", "invitation.used"].includes(e.code);

/** The invitation's signed-in shape while it loads: the role and expiry rows, then Accept. */
const LOADING_FIELDS: FieldShape[] = [{ control: "key-value", rows: 2, keyWidth: "10ch" }];

/**
 * `/invite/[token]`: accept an org invitation (AuthPage). The public preview (org name, role,
 * expiry) and the visitor's session (`null` signed out) come from the cache the (auth) layout
 * prefetched: signed in → "Accept"; signed out → "Sign in to accept" (sign-in comes back here),
 * or create an account and join. Accepting switches to the org; the other tabs are told (a sign-up
 * signs in, an accept switches the org), the cache is dropped and home loads as a new document. The
 * token is single-use and time-limited; the kernel decides and rate-limits.
 */
export default function InviteView({ token }: { token: string }) {
  const t = useTranslations("invite");
  const tm = useTranslations("members");
  const tc = useTranslations("common");
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const previewQuery = invitationQuery(token);
  const preview = useQuery({
    ...previewQuery,
    retryOnMount: retryOnMountOf(previewQuery.queryKey),
  });
  const meQuery = maybeMeQuery();
  const me = useQuery({ ...meQuery, retryOnMount: retryOnMountOf(meQuery.queryKey) });
  // An accept that found the link dead meanwhile.
  const [dead, setDead] = useState<unknown>();
  const [signup, setSignup] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const here = invitePath(token);
  // A new session or org: the cache is dropped as a whole before the navigation.
  const { mutateAsync: acceptAndEnter } = useAppMutation({
    fn: async (input: SignupInput | undefined) => {
      const r = await acceptInvitation(token, input);
      // Enter the org just joined; a failed switch does not undo the join (home can pick it)
      await setCurrentOrg(r.orgId).catch(() => {});
      return r;
    },
    invalidates: () => [],
  });

  async function accept(input?: SignupInput) {
    setPending(true);
    setActionError(undefined);
    try {
      await acceptAndEnter(input);
    } catch (e) {
      setPending(false);
      if (deadLink(e)) setDead(e);
      else if (input === undefined && unauthenticated(e)) router.push(loginPathFor(here));
      else setActionError(errorMessage(e));
      return;
    }
    // A sign-up signed in; an accept switched the org: the other tabs follow (spec §3.2)
    broadcastSession(input === undefined ? "org-switched" : "signed-in");
    // A new session or org: drop the cache, then load the new document (ruling R4); the button
    // stays pending until then.
    await resetSession(qc, () => navigateBrowser(HOME_PATH));
  }

  const preferences = usePreferences();
  const failure =
    dead ??
    (preview.data === undefined ? preview.error : null) ??
    (me.data === undefined ? me.error : null);
  if (failure) {
    const gone = deadLink(failure);
    return (
      <AuthPage title={gone ? t("invalidTitle") : t("title")} preferences={preferences}>
        <Stack gap={16}>
          <FormError message={errorMessage(failure)} />
          {gone ? (
            <Text variant="prose" tone="muted">
              {t("invalidHint")}
            </Text>
          ) : (
            <Button
              variant="primary"
              density="prominent"
              onClick={() => {
                if (preview.isError) void preview.refetch();
                if (me.isError) void me.refetch();
              }}
            >
              {tc("retry")}
            </Button>
          )}
          <Button density="prominent" onClick={() => router.replace(HOME_PATH)}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  if (preview.data === undefined || me.data === undefined) {
    // The subtitle names the org (it comes with the preview). Signed out (when the session is
    // known), the card ends with the sign-in hint and its two buttons; else with Accept.
    const signedOut = me.data === null;
    return (
      <AuthPage
        title={t("title")}
        preferences={preferences}
        loading={{
          fields: LOADING_FIELDS,
          subtitle: true,
          ...(signedOut ? { hint: t("signInHint"), buttons: 2 } : {}),
        }}
      />
    );
  }
  const invite = preview.data;
  const signedIn = me.data !== null;
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
