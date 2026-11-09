"use client";

import {
  Button,
  type MenuItem,
  type ObjectCardLoaded,
  Sheet,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStartConnect } from "../lib/connect";
import {
  type ConnectorDetail,
  type CredentialValue,
  clearMyCredential,
  setMyCredential,
} from "../lib/connectors";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { buildCredential, CredentialFields, EMPTY_CREDENTIAL } from "./ConnectorForm";
import { ConnectorGuideSheet } from "./ConnectorGuides";
import { ConnectorPermissionsSheet } from "./ConnectorPermissions";
import { FormError } from "./form-error";

/** Where an org admin edits a connector's configuration: its detail page's 设置 tab. */
export const connectorConfigHref = (connectorId: string) =>
  `/connectors/${encodeURIComponent(connectorId)}?tab=settings`;

/** The anchor of a personal connector's card on `/account/connections` (see `connectionHref`). */
export const connectionAnchor = (connectorId: string) => `connector-${connectorId}`;

/** The card parts the viewer's own connection decides: its state, one primary, the ⋯ menu. */
export type ConnectionCardParts = Pick<
  ObjectCardLoaded,
  "state" | "primary" | "menu" | "oneButton"
>;

type Open = { kind: "permissions" | "howTo" | "credential"; id: string };

/**
 * The viewer's own connection to personal connectors, shared by the `/connectors` cards and the
 * `/account/connections` cards (maintainer decision 2026-11-09: one button per card, the rest in
 * ⋯). `parts(app)` gives a card its state, its one primary and its menu:
 *
 * - not connected: 连接 (OAuth: the connect flow, back to this page) or, for a credential, 连接
 *   (`/connectors`) / 填写凭据 (`/account/connections`) opening the credential sheet; ⋯ 如何连接
 *   (when the template's guide has a member section) and 修改配置 for org admins on `/connectors`;
 * - connected: on `/connectors` 权限; on `/account/connections` 权限 for OAuth and 更新凭据 for a
 *   credential; ⋯ 如何连接, 重新连接 (OAuth) or 更新凭据 / 权限, 修改配置 (org admins, `/connectors`),
 *   then 断开连接 (OAuth) or 清除凭据, danger.
 *
 * 断开连接 / 清除凭据 act at once with a toast, without a confirmation dialog: they only end the
 * viewer's own connection, which 连接 restores at any time, and nothing else is lost (spec §6.7:
 * a dangerous confirmation is for what cannot be undone; feedback on the result is a toast).
 * `overlays` holds the open sheet (权限, 如何连接, the credential). `anchor` (the account page)
 * opens the credential sheet of the connector named by `#connector-<id>` (a conversation's 连接).
 */
export function usePersonalConnections({
  orgId,
  admin,
  page,
  connectors,
  guides,
  anchor = false,
}: {
  orgId: string;
  /** The viewer manages connectors (`connectors.manage`). */
  admin: boolean;
  page: "connectors" | "account";
  /** The personal connectors' details as loaded (the viewer's credential status). */
  connectors: readonly ConnectorDetail[];
  /** The connectors whose template's guide has a member section (`useMemberGuides`). */
  guides: ReadonlySet<string>;
  anchor?: boolean;
}): { parts(app: ConnectorDetail): ConnectionCardParts | null; overlays: ReactNode } {
  const t = useTranslations("connections");
  const tc = useTranslations("connectors");
  const tg = useTranslations("setupGuide");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const { start, starting } = useStartConnect(orgId);
  const [open, setOpen] = useState<Open | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  // My credential changes this connector's credential status: it is read again.
  const clearMine = useAppMutation({
    fn: (id: string) => clearMyCredential(orgId, id),
    invalidates: (id) => [keys.org(orgId).connector(id)],
  });

  // `#connector-<id>`: the credential sheet of that connector opens once it is loaded (an OAuth
  // connector only scrolls to its card, which carries the id).
  const anchored = useRef<string | null>(null);
  const ids = connectors.map((c) => `${c.id}:${c.auth.type}`).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: rerun when the loaded connectors change
  useEffect(() => {
    if (!anchor) return;
    const check = () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#connector-") || anchored.current === hash) return;
      const id = decodeURIComponent(hash.slice("#connector-".length));
      const app = connectors.find((c) => c.id === id);
      if (app === undefined) return;
      anchored.current = hash;
      document.getElementById(connectionAnchor(id))?.scrollIntoView?.({ block: "center" });
      if (hasCredentialFields(app)) setOpen({ kind: "credential", id });
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [anchor, ids]);

  async function disconnect(app: ConnectorDetail) {
    setClearing(app.id);
    try {
      await clearMine.mutateAsync(app.id);
      toast.success(
        app.auth.type === "oauth_code"
          ? t("disconnected", { connector: app.name })
          : t("cleared", { connector: app.name }),
      );
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setClearing(null);
    }
  }

  function parts(app: ConnectorDetail): ConnectionCardParts | null {
    const oauth = app.auth.type === "oauth_code";
    if (!oauth && !hasCredentialFields(app)) return null;
    const connected = app.credential.status === "connected";
    const busy = clearing === app.id;
    const howTo: MenuItem[] = guides.has(app.id)
      ? [{ label: tg("howToConnect"), onSelect: () => setOpen({ kind: "howTo", id: app.id }) }]
      : [];
    const config: MenuItem[] =
      admin && page === "connectors"
        ? [{ label: t("editConfig"), href: connectorConfigHref(app.id) }]
        : [];
    const permissions = () => setOpen({ kind: "permissions", id: app.id });
    const credential = () => setOpen({ kind: "credential", id: app.id });
    const connect = () => void start(app.id);
    const state = connected
      ? { label: t("connected"), tone: "ok" as const }
      : { label: t("missing"), tone: "warn" as const };
    if (!connected) {
      return {
        state,
        oneButton: true,
        primary: oauth
          ? { label: t("oauthConnect"), onSelect: connect, loading: starting }
          : {
              label: page === "account" ? t("enterCredential") : t("oauthConnect"),
              onSelect: credential,
            },
        menu: [...howTo, ...config],
      };
    }
    const end: MenuItem = {
      label: oauth ? t("disconnect") : t("clearCredential"),
      danger: true,
      disabled: busy,
      onSelect: () => void disconnect(app),
    };
    if (oauth) {
      return {
        state,
        oneButton: true,
        primary: { label: tc("cards.permissions"), onSelect: permissions },
        menu: [
          ...howTo,
          { label: t("reconnect"), onSelect: connect, disabled: starting },
          ...config,
          end,
        ],
      };
    }
    return {
      state,
      oneButton: true,
      primary:
        page === "account"
          ? { label: t("updateCredential"), onSelect: credential }
          : { label: tc("cards.permissions"), onSelect: permissions },
      menu: [
        page === "account"
          ? { label: tc("cards.permissions"), onSelect: permissions }
          : { label: t("updateCredential"), onSelect: credential },
        ...howTo,
        ...config,
        end,
      ],
    };
  }

  const app = open === null ? undefined : connectors.find((c) => c.id === open.id);
  const close = () => setOpen(null);
  const overlays =
    app === undefined || open === null ? null : open.kind === "permissions" ? (
      <ConnectorPermissionsSheet orgId={orgId} connector={app} onClose={close} />
    ) : open.kind === "howTo" ? (
      <ConnectorGuideSheet orgId={orgId} connector={app} admin={admin} onClose={close} />
    ) : (
      <CredentialSheet orgId={orgId} app={app} onClose={close} />
    );
  return { parts, overlays };
}

/** A connector whose credential the viewer types in (a token, a user and password, headers). */
const hasCredentialFields = (app: ConnectorDetail) =>
  app.auth.type === "bearer" ||
  app.auth.type === "api_key" ||
  app.auth.type === "basic" ||
  app.auth.type === "headers";

/**
 * 填写凭据 / 更新凭据: the viewer's own credential for a connector, in a sheet (the fields of the
 * auth type, 保存 in the footer, enabled once something is typed). Saving replaces the stored one.
 */
function CredentialSheet({
  orgId,
  app,
  onClose,
}: {
  orgId: string;
  app: ConnectorDetail;
  onClose(): void;
}) {
  const t = useTranslations("connections");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [values, setValues] = useState(EMPTY_CREDENTIAL);
  const [error, setError] = useState<string>();
  const saveMine = useAppMutation({
    fn: (credential: CredentialValue) => setMyCredential(orgId, app.id, credential),
    invalidates: () => [keys.org(orgId).connector(app.id)],
  });
  const auth = app.auth;
  const type = auth.type === "oauth_code" || auth.type === "oauth_client" ? "none" : auth.type;
  const credential = buildCredential(type, values, auth.type === "headers" ? auth.names : []);
  const connected = app.credential.status === "connected";
  const onSave = async () => {
    if (credential === undefined) return;
    setError(undefined);
    try {
      await saveMine.mutateAsync(credential);
      toast.success(t("saved", { connector: app.name }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={t(connected ? "updateCredentialTitle" : "enterCredentialTitle", { name: app.name })}
      mark={{ text: app.name, image: app.icon ?? null }}
      dirty={credential !== undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={credential === undefined || saveMine.isPending}
            loading={saveMine.isPending}
            onClick={() => void onSave()}
          >
            {t("save")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {connected ? t("updateHint") : t("sectionHint")}
        </Text>
        {error !== undefined && <FormError message={error} />}
        <CredentialFields auth={auth} values={values} onChange={setValues} />
      </Stack>
    </Sheet>
  );
}
