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
} from "../../../../../components/ConnectorForm";
import { FormError } from "../../../../../components/form-error";
import { OrgGate } from "../../../../../components/OrgGate";
import { useSettingsNav } from "../../../../../components/settings-nav";
import { ApiClientError } from "../../../../../lib/api";
import { useStartConnect } from "../../../../../lib/connect";
import {
  type ConnectorDetail,
  clearMyCredential,
  getConnector,
  listConnectors,
  setMyCredential,
} from "../../../../../lib/connectors";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/connections`：个人连接（SettingsPage）——需要每人各自凭据的连接器，
 * 逐个填写或清除自己的凭据。每个连接器一个分组，锚点 `connector-<connectorId>`（对话里的「连接」按钮跳到这里）。
 */
export default function ConnectionsPage() {
  return <OrgGate>{(orgId) => <Connections orgId={orgId} />}</OrgGate>;
}

/** 个人凭据型连接器的详情（含当前用户的凭据状态）。 */
async function personalConnectors(orgId: string): Promise<ConnectorDetail[]> {
  const { connectors } = await listConnectors(orgId);
  const personal = connectors.filter(
    (a) => a.auth.type !== "none" && a.auth.ownership === "personal",
  );
  return Promise.all(personal.map((a) => getConnector(orgId, a.id).then((r) => r.connector)));
}

function Connections({ orgId }: { orgId: string }) {
  const t = useTranslations("connections");
  const errorMessage = useErrorMessage();
  const nav = useSettingsNav();
  const { state, reload } = useLoad(() => personalConnectors(orgId), [orgId]);
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
          <ConnectorConnection key={app.id} orgId={orgId} app={app} onChanged={reload} />
        ))
      )}
    </SettingsPage>
  );
}

function ConnectorConnection({
  orgId,
  app,
  onChanged,
}: {
  orgId: string;
  app: ConnectorDetail;
  onChanged(): void;
}) {
  const t = useTranslations("connections");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_CREDENTIAL);
  const [pending, setPending] = useState<"save" | "clear">();
  const { start, starting } = useStartConnect(orgId);
  const auth = app.auth;
  if (auth.type === "none" || auth.type === "oauth_client") return null;
  const connected = app.credential.status === "connected";

  if (auth.type === "oauth_code") {
    // OAuth：没有可填的凭据，只有授权（连接 / 重新连接）与断开
    async function disconnect() {
      setPending("clear");
      try {
        await clearMyCredential(orgId, app.id);
        toast.success(t("cleared", { connector: app.name }));
        onChanged();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setPending(undefined);
      }
    }
    return (
      <FormSection id={`app-${app.id}`} title={app.name} description={t("oauthHint")}>
        <StatusMark
          status={connected ? "success" : "waiting"}
          label={connected ? t("connected") : t("missing")}
        />
        <Stack direction="row" gap={8}>
          <Button
            variant="secondary"
            loading={starting}
            disabled={pending !== undefined}
            onClick={() => void start(app.id)}
          >
            {connected ? t("reconnect") : t("oauthConnect")}
          </Button>
          {connected && (
            <Button
              variant="danger"
              loading={pending === "clear"}
              disabled={starting || pending !== undefined}
              onClick={() => void disconnect()}
            >
              {t("disconnect")}
            </Button>
          )}
        </Stack>
      </FormSection>
    );
  }

  const names = auth.type === "headers" ? auth.names : [];
  const credential = buildCredential(auth.type, values, names);

  async function run(kind: "save" | "clear") {
    setPending(kind);
    try {
      if (kind === "save" && credential !== undefined) {
        await setMyCredential(orgId, app.id, credential);
        setValues(EMPTY_CREDENTIAL);
        toast.success(t("saved", { connector: app.name }));
      } else if (kind === "clear") {
        await clearMyCredential(orgId, app.id);
        toast.success(t("cleared", { connector: app.name }));
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
        {/* 每个连接器一个分组：保存按钮用次级样式，页面不出现多个主操作 */}
        <Button
          variant="secondary"
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
