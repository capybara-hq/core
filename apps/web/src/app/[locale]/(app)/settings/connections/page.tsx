"use client";

import {
  Button,
  FormSection,
  SettingsPage,
  Skeleton,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  buildCredential,
  CredentialFields,
  EMPTY_CREDENTIAL,
} from "../../../../../components/AppForm";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { usePersonalSettingsNav } from "../../../../../components/settings-nav";
import { ApiClientError } from "../../../../../lib/api";
import {
  type AppDetail,
  clearMyCredential,
  getApp,
  listApps,
  setMyCredential,
} from "../../../../../lib/apps";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/connections`：个人连接（SettingsPage）——需要每人各自凭据的应用，
 * 逐个填写或清除自己的凭据。每个应用一个分组，锚点 `app-<appId>`（对话里的「连接」按钮跳到这里）。
 */
export default function ConnectionsPage() {
  return <OrgGate>{(orgId) => <Connections orgId={orgId} />}</OrgGate>;
}

/** 个人凭据型应用的详情（含当前用户的凭据状态）。 */
async function personalApps(orgId: string): Promise<AppDetail[]> {
  const { apps } = await listApps(orgId);
  const personal = apps.filter((a) => a.auth.type !== "none" && a.auth.ownership === "personal");
  return Promise.all(personal.map((a) => getApp(orgId, a.id).then((r) => r.app)));
}

function Connections({ orgId }: { orgId: string }) {
  const t = useTranslations("connections");
  const errorMessage = useErrorMessage();
  const nav = usePersonalSettingsNav();
  const { state, reload } = useLoad(() => personalApps(orgId), [orgId]);
  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="connections">
      {state.kind === "loading" ? (
        <Skeleton rows={4} />
      ) : state.kind === "error" ? (
        <FormError message={errorMessage(new ApiClientError(0, state.code, state.code))} />
      ) : state.data.length === 0 ? (
        <Stack gap={4}>
          <Text>{t("empty")}</Text>
          <Text variant="small" tone="muted">
            {t("emptyHint")}
          </Text>
        </Stack>
      ) : (
        state.data.map((app) => (
          <AppConnection key={app.id} orgId={orgId} app={app} onChanged={reload} />
        ))
      )}
    </SettingsPage>
  );
}

function AppConnection({
  orgId,
  app,
  onChanged,
}: {
  orgId: string;
  app: AppDetail;
  onChanged(): void;
}) {
  const t = useTranslations("connections");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_CREDENTIAL);
  const [pending, setPending] = useState<"save" | "clear">();
  const auth = app.auth;
  if (auth.type === "none") return null;
  const names = auth.type === "headers" ? auth.names : [];
  const credential = buildCredential(auth.type, values, names);
  const connected = app.credential.status === "connected";

  async function run(kind: "save" | "clear") {
    setPending(kind);
    try {
      if (kind === "save" && credential !== undefined) {
        await setMyCredential(orgId, app.id, credential);
        setValues(EMPTY_CREDENTIAL);
        toast.success(t("saved", { app: app.name }));
      } else if (kind === "clear") {
        await clearMyCredential(orgId, app.id);
        toast.success(t("cleared", { app: app.name }));
      }
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <FormSection id={`app-${app.id}`} title={app.name} description={t("sectionHint")}>
      <StatusMark
        status={connected ? "success" : "waiting"}
        label={connected ? t("connected") : t("missing")}
      />
      <CredentialFields auth={auth} values={values} onChange={setValues} />
      <Stack direction="row" gap={8}>
        <Button
          variant="primary"
          loading={pending === "save"}
          disabled={credential === undefined || pending !== undefined}
          onClick={() => void run("save")}
        >
          {t("save")}
        </Button>
        {connected && (
          <Button
            variant="danger"
            loading={pending === "clear"}
            disabled={pending !== undefined}
            onClick={() => void run("clear")}
          >
            {t("clear")}
          </Button>
        )}
      </Stack>
    </FormSection>
  );
}
