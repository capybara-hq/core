"use client";

import {
  Button,
  FormSection,
  SettingsPage,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQueries } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  buildCredential,
  CredentialFields,
  EMPTY_CREDENTIAL,
} from "../../../../components/ConnectorForm";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import type { ApiClientError } from "../../../../lib/api";
import { useStartConnect } from "../../../../lib/connect";
import {
  type ConnectorDetail,
  type CredentialValue,
  clearMyCredential,
  personalConnectors,
  setMyCredential,
} from "../../../../lib/connectors";
import { retryOnMountOf } from "../../../../lib/query/client";
import { connectorQuery, connectorsQuery } from "../../../../lib/query/conversation";
import { useAppMutation } from "../../../../lib/query/define";
import { keys } from "../../../../lib/query/keys";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/account/connections`：个人连接（SettingsPage）——需要每人各自凭据的连接器，
 * 逐个填写或清除自己的凭据。每个连接器一个分组，锚点 `connector-<connectorId>`（对话里的「连接」按钮跳到这里）。
 * From the query cache (the layout prefetched it on a first load): the list, then each personal
 * connector's detail (with this person's credential status); one the kernel no longer lets the
 * person see is left out. A change invalidates that connector, which is read again.
 */
export default function ConnectionsView() {
  const ws = useWorkspace({ setup: "step" });
  if (ws.kind !== "ok") return null;
  return <Connections orgId={ws.orgId} />;
}

function Connections({ orgId }: { orgId: string }) {
  const scope = usePagePath("home");
  const t = useTranslations("connections");
  const nav = useAccountNav();
  const list = usePageQuery(connectorsQuery(orgId));
  const personal = list.kind === "ready" ? personalConnectors(list.data.connectors) : [];
  const details = useQueries({
    queries: personal.map((a) => {
      const q = connectorQuery(orgId, a.id);
      return { ...q, retryOnMount: retryOnMountOf(q.queryKey) };
    }),
  });
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const header = {
    path: [...scope, { label: "account", href: "/account/connections" }, { label: "connections" }],
    title: t("nav.connections"),
  };
  // Until the list and every personal connector's detail answered.
  if (list.kind === "loading" || details.some((d) => d.data === undefined && d.error === null)) {
    const sections =
      list.kind === "loading"
        ? [{ fields: LOADING_FIELDS }]
        : personal.map((a) => ({ fields: LOADING_FIELDS, title: a.name }));
    return (
      <SettingsPage header={header} nav={nav} activeNav="connections" loading={{ sections }} />
    );
  }
  // A detail the kernel refuses (403 / 404: the person may no longer see it) is left out, even
  // when an older answer is cached; any other failure without data is the page's error state.
  const refused = (e: ApiClientError | null) => e?.status === 403 || e?.status === 404;
  const failed = details.filter(
    (d) => d.data === undefined && d.error !== null && !refused(d.error),
  );
  if (failed.length > 0) {
    return <ErrorFrame reset={() => failed.forEach((d) => void d.refetch())} />;
  }
  const shown = details.flatMap((d) => (d.data === undefined || refused(d.error) ? [] : [d.data]));
  return (
    <SettingsPage header={header} nav={nav} activeNav="connections">
      {shown.length === 0 ? (
        <Stack gap={4}>
          <Text>{t("empty")}</Text>
          <Text variant="small" tone="muted">
            {t("emptyHint")}
          </Text>
        </Stack>
      ) : (
        shown.map((app) => <ConnectorConnection key={app.id} orgId={orgId} app={app} />)
      )}
    </SettingsPage>
  );
}

/** A personal connector's section while it loads: its status line and a credential field. */
const LOADING_FIELDS = [{}, {}];

function ConnectorConnection({ orgId, app }: { orgId: string; app: ConnectorDetail }) {
  const t = useTranslations("connections");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_CREDENTIAL);
  const [pending, setPending] = useState<"save" | "clear">();
  const { start, starting } = useStartConnect(orgId);
  // My credential changes this connector's credential status: it is read again.
  const saveMine = useAppMutation({
    fn: (credential: CredentialValue) => setMyCredential(orgId, app.id, credential),
    invalidates: () => [keys.org(orgId).connector(app.id)],
  });
  const clearMine = useAppMutation({
    fn: () => clearMyCredential(orgId, app.id),
    invalidates: () => [keys.org(orgId).connector(app.id)],
  });
  const auth = app.auth;
  if (auth.type === "none" || auth.type === "oauth_client") return null;
  const connected = app.credential.status === "connected";

  if (auth.type === "oauth_code") {
    // OAuth：没有可填的凭据，只有授权（连接 / 重新连接）与断开
    async function disconnect() {
      setPending("clear");
      try {
        await clearMine.mutateAsync(undefined);
        toast.success(t("cleared", { connector: app.name }));
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
        await saveMine.mutateAsync(credential);
        setValues(EMPTY_CREDENTIAL);
        toast.success(t("saved", { connector: app.name }));
      } else if (kind === "clear") {
        await clearMine.mutateAsync(undefined);
        toast.success(t("cleared", { connector: app.name }));
      }
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
