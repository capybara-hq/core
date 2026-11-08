"use client";

import {
  AuthPage,
  Button,
  Card,
  Field,
  type FieldShape,
  Input,
  KeyValue,
  Select,
  Stack,
  Text,
  versionLabel,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { FormError } from "../../../../components/form-error";
import { useDeviceName } from "../../../../components/use-device-name";
import { useRouter } from "../../../../i18n/navigation";
import { ApiClientError } from "../../../../lib/api";
import { loginPathFor } from "../../../../lib/auth-sources";
import {
  codeParam,
  confirmDevice,
  type DeviceConfirmInput,
  defaultDeviceOrg,
  denyDevice,
  normalizeUserCode,
  osLabel,
  type PendingMachine,
} from "../../../../lib/device-sign-in";
import { isDeviceName } from "../../../../lib/devices";
import { usePreferences } from "../../../../lib/preferences";
import { retryOnMountOf } from "../../../../lib/query/client";
import { pendingDeviceQuery } from "../../../../lib/query/device-sign-in";
import { devicesQuery } from "../../../../lib/query/devices";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { maybeMeQuery } from "../../../../lib/query/shell";
import { HOME_PATH } from "../../../../lib/routes";
import type { Me } from "../../../../lib/session";
import { useErrorMessage } from "../../../../lib/use-error-message";

/** No session or an expired one (apiFetch tried one refresh): sign in and come back here. */
const needsLogin = (e: unknown) => e instanceof ApiClientError && e.status === 401;

/**
 * The code cannot be used any more: unknown, expired, or a confirmation whose credential could
 * not be handed over (the kernel revoked the machine again). The person runs login again.
 */
const startOver = (e: unknown) =>
  e instanceof ApiClientError &&
  (e.code === "device_sign_in.code_invalid" ||
    e.code === "device_sign_in.expired" ||
    e.code === "device_sign_in.unavailable");

/** The `新建设备` choice of the device select (a device id is a uuid, never this). */
const NEW = "new";

/** The confirm card while it loads: the code, the machine's rows, org, device and name. */
const LOADING_FIELDS: FieldShape[] = [
  { control: "text" },
  { control: "key-value", rows: 3, keyWidth: "10ch" },
  { control: "select" },
  { control: "select" },
  { control: "input" },
];

/** What confirming allows (static: the loading card shows it too). */
function Disclosure() {
  const t = useTranslations("deviceLink");
  return (
    <Card tone="danger">
      <div role="note">
        <Text tone="warn">{t("disclosure")}</Text>
      </div>
    </Card>
  );
}

/**
 * `/devices/link`: confirm a machine's `capybara-device login` (AuthPage; environments spec §6.2,
 * §13.3). The code stands out for comparison with the terminal, then the machine (name, system,
 * program version), the org, the device (新建设备 named after the machine by default, or one
 * of the person's local devices in that org) and the disclosure; 确认连接 or 拒绝.
 * Without a code the page asks for the one the terminal shows.
 */
export default function DeviceLinkView({ code: raw }: { code: string }) {
  const code = codeParam(raw);
  if (code === "") return <EnterCode />;
  return <ConfirmDevice key={code} code={code} />;
}

/** No `?code=`: the person types the code the terminal shows. */
function EnterCode() {
  const t = useTranslations("deviceLink");
  const router = useRouter();
  const preferences = usePreferences();
  const [value, setValue] = useState("");
  const code = normalizeUserCode(value);
  const submit = () => {
    if (code !== null) router.replace(`/devices/link?code=${code}`);
  };
  return (
    <AuthPage title={t("enterTitle")} subtitle={t("enterSubtitle")} preferences={preferences}>
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack gap={16}>
          <Field label={t("code")} help={t("codeHelp")}>
            <Input
              value={value}
              autoFocus
              autoComplete="off"
              maxLength={16}
              placeholder="XXXX-XXXX"
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" density="prominent" disabled={code === null}>
            {t("continue")}
          </Button>
        </Stack>
      </form>
    </AuthPage>
  );
}

type Outcome = { kind: "confirmed"; orgId: string; deviceId: string } | { kind: "denied" };

function ConfirmDevice({ code }: { code: string }) {
  const t = useTranslations("deviceLink");
  const tc = useTranslations("common");
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const preferences = usePreferences();
  const pendingQ = pendingDeviceQuery(code);
  const pending = useQuery({ ...pendingQ, retryOnMount: retryOnMountOf(pendingQ.queryKey) });
  const meQ = maybeMeQuery();
  const me = useQuery({ ...meQ, retryOnMount: retryOnMountOf(meQ.queryKey) });
  const [outcome, setOutcome] = useState<Outcome>();
  // A confirm or deny that found the code unusable meanwhile.
  const [gone, setGone] = useState<unknown>();
  const here = `/devices/link?code=${code}`;
  const home = () => router.replace(HOME_PATH);

  // A refused read or action that needs a new session signs in again, back here.
  const onFailure = (e: unknown): string | undefined => {
    if (needsLogin(e)) router.replace(loginPathFor(here));
    else if (startOver(e)) setGone(e);
    else return errorMessage(e);
    return undefined;
  };

  // Signed out in the browser (the session ended after the layout let the page through).
  const signedOut = me.data === null || (pending.data === undefined && needsLogin(pending.error));
  useEffect(() => {
    if (signedOut) router.replace(loginPathFor(here));
  }, [signedOut, router, here]);
  if (signedOut) return null;

  const failure =
    gone ??
    (pending.data === undefined ? pending.error : null) ??
    (me.data === undefined ? me.error : null);
  if (failure) {
    const over = startOver(failure);
    return (
      <AuthPage title={over ? t("invalidTitle") : t("title")} preferences={preferences}>
        <Stack gap={16}>
          <FormError message={errorMessage(failure)} />
          {over ? (
            <Text variant="prose" tone="muted">
              {t("invalidHint")}
            </Text>
          ) : (
            <Button
              variant="primary"
              density="prominent"
              onClick={() => {
                if (pending.error) void pending.refetch();
                if (me.error) void me.refetch();
              }}
            >
              {tc("retry")}
            </Button>
          )}
          <Button density="prominent" onClick={home}>
            {t("goHome")}
          </Button>
        </Stack>
      </AuthPage>
    );
  }
  if (outcome !== undefined) {
    const inCurrentOrg = outcome.kind === "confirmed" && me.data?.currentOrgId === outcome.orgId;
    return (
      <AuthPage
        title={outcome.kind === "confirmed" ? t("doneTitle") : t("deniedTitle")}
        subtitle={outcome.kind === "confirmed" ? t("doneHint") : t("deniedHint")}
        preferences={preferences}
      >
        {outcome.kind === "confirmed" && inCurrentOrg ? (
          <Button
            variant="primary"
            density="prominent"
            onClick={() => router.replace(`/devices/${encodeURIComponent(outcome.deviceId)}`)}
          >
            {t("openDevice")}
          </Button>
        ) : (
          <Button variant="primary" density="prominent" onClick={home}>
            {t("goHome")}
          </Button>
        )}
      </AuthPage>
    );
  }
  if (pending.data === undefined || me.data === undefined || me.data === null) {
    return (
      <AuthPage
        title={t("title")}
        subtitle={t("subtitle")}
        preferences={preferences}
        // the disclosure is static: it renders for real; then 确认连接 and 拒绝
        loading={{ fields: LOADING_FIELDS, note: <Disclosure />, buttons: 2 }}
      />
    );
  }
  return (
    <AuthPage title={t("title")} subtitle={t("subtitle")} preferences={preferences}>
      <ConfirmForm
        code={code}
        machine={pending.data.machine}
        me={me.data}
        onFailure={onFailure}
        onDone={setOutcome}
      />
    </AuthPage>
  );
}

function ConfirmForm({
  code,
  machine,
  me,
  onFailure,
  onDone,
}: {
  code: string;
  machine: PendingMachine;
  me: Me;
  onFailure(e: unknown): string | undefined;
  onDone(o: Outcome): void;
}) {
  const t = useTranslations("deviceLink");
  const te = useTranslations("devices");
  const deviceLabel = useDeviceName();
  const memberships = me.memberships;
  const [orgId, setOrgId] = useState(() => defaultDeviceOrg(me));
  const [target, setTarget] = useState(NEW);
  const [name, setName] = useState(machine.name);
  const [error, setError] = useState<string>();
  const envQ = devicesQuery(orgId ?? "");
  const devices = useQuery({
    ...envQ,
    enabled: orgId !== undefined,
    retryOnMount: retryOnMountOf(envQ.queryKey),
  });
  const locals = (devices.data?.items ?? []).filter((e) => e.source === "local");
  const confirm = useAppMutation({
    fn: (input: DeviceConfirmInput) => confirmDevice(input),
    invalidates: (input) => [keys.org(input.orgId).devices()],
  });
  const deny = useAppMutation({ fn: () => denyDevice(code), invalidates: () => [] });
  const busy = confirm.isPending || deny.isPending;
  const valid = orgId !== undefined && (target !== NEW || isDeviceName(name));

  const onConfirm = async () => {
    if (orgId === undefined || !valid || busy) return;
    setError(undefined);
    const input: DeviceConfirmInput =
      target === NEW
        ? { userCode: code, orgId, name: name.trim() }
        : { userCode: code, orgId, deviceId: target };
    try {
      const r = await confirm.mutateAsync(input);
      onDone({ kind: "confirmed", orgId, deviceId: r.deviceId });
    } catch (e) {
      setError(onFailure(e));
    }
  };
  const onDeny = async () => {
    if (busy) return;
    setError(undefined);
    try {
      await deny.mutateAsync(undefined);
      onDone({ kind: "denied" });
    } catch (e) {
      setError(onFailure(e));
    }
  };

  return (
    <Stack gap={16}>
      <Stack gap={8}>
        <Text variant="h1" as="p">
          {code}
        </Text>
        <KeyValue
          keyWidth="10ch"
          rows={[
            { k: t("machine"), v: machine.name },
            { k: t("system"), v: `${osLabel(machine.os)} · ${machine.arch}` },
            { k: t("programVersion"), v: versionLabel(machine.programVersion) },
          ]}
        />
      </Stack>
      {orgId === undefined ? (
        <Text variant="prose" tone="muted">
          {t("noOrg")}
        </Text>
      ) : (
        <Stack gap={12}>
          <Field label={t("org")}>
            <Select
              value={orgId}
              disabled={busy}
              onChange={(e) => {
                setOrgId(e.target.value);
                setTarget(NEW);
              }}
              options={memberships.map((m) => ({ value: m.orgId, label: m.name }))}
            />
          </Field>
          <Field label={t("device")}>
            <Select
              value={target}
              disabled={busy}
              onChange={(e) => setTarget(e.target.value)}
              options={[
                { value: NEW, label: t("newDevice") },
                ...locals.map((e) => ({ value: e.id, label: deviceLabel(e) })),
              ]}
            />
          </Field>
          {target === NEW && (
            <Field label={t("name")} required help={te("create.nameHelp")}>
              <Input
                value={name}
                maxLength={64}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          )}
        </Stack>
      )}
      <Disclosure />
      {error !== undefined && <FormError message={error} />}
      <Stack gap={8}>
        <Button
          variant="primary"
          density="prominent"
          loading={confirm.isPending}
          disabled={!valid || busy}
          onClick={() => void onConfirm()}
        >
          {t("confirm")}
        </Button>
        <Button
          density="prominent"
          loading={deny.isPending}
          disabled={busy}
          onClick={() => void onDeny()}
        >
          {t("deny")}
        </Button>
      </Stack>
    </Stack>
  );
}
