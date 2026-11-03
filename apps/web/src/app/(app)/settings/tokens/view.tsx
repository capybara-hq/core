"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  Dialog,
  Field,
  Input,
  type MenuItem,
  SecretReveal,
  Select,
  SettingsPage,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { type OrgRole, roleAtLeast } from "../../../../lib/members";
import {
  createServiceToken,
  revokeServiceToken,
  SERVICE_TOKEN_ROLES,
  type ServiceToken,
  type ServiceTokenRole,
} from "../../../../lib/orgs";
import { useAppMutation } from "../../../../lib/query/define";
import { keys } from "../../../../lib/query/keys";
import { usePageQuery } from "../../../../lib/query/page-query";
import { serviceTokensQuery } from "../../../../lib/query/settings";
import { useWorkspace } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/settings/tokens`: the org's service tokens (SettingsPage, group 组织; `org.tokens.manage`,
 * org admins): list, create (a role up to the actor's, optional expiry; the token is shown once)
 * and revoke after a confirmation. From the query cache (the layout prefetched it on a first load);
 * a change invalidates the tokens.
 */
const EXPIRY_DAYS = ["never", "30", "90", "365"] as const;
type Expiry = (typeof EXPIRY_DAYS)[number];

export default function TokensView() {
  const ws = useWorkspace({ min: "admin" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Tokens orgId={ws.orgId} actor={ws.role} />;
}

function Tokens({ orgId, actor }: { orgId: string; actor: OrgRole }) {
  const scope = usePagePath("org");
  const t = useTranslations("tokens");
  const tr = useTranslations("members.roles");
  const nav = useOrgSettingsNav();
  const read = usePageQuery(serviceTokensQuery(orgId));
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ServiceToken | null>(null);
  if (read.kind === "notFound") return <NotFound />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  const rows = read.kind === "ready" ? read.data.tokens : [];
  const columns: Column<ServiceToken>[] = [
    { key: "name", header: t("columns.name"), cell: (r) => r.name },
    {
      key: "role",
      header: t("columns.role"),
      cell: (r) => (r.role === null ? "—" : tr(r.role)),
    },
    {
      key: "created",
      header: t("columns.created"),
      tone: "muted",
      cell: (r) => <DateTime value={r.createdAt} />,
    },
    {
      key: "expires",
      header: t("columns.expires"),
      tone: "muted",
      cell: (r) =>
        r.expiresAt === null ? (
          t("noExpiry")
        ) : Date.parse(r.expiresAt) <= Date.now() ? (
          <StatusMark status="cancelled" label={t("expired")} />
        ) : (
          <DateTime value={r.expiresAt} />
        ),
    },
    {
      key: "lastUsed",
      header: t("columns.lastUsed"),
      tone: "muted",
      cell: (r) => (r.lastUsedAt === null ? t("neverUsed") : <DateTime value={r.lastUsedAt} />),
    },
  ];
  const menu = (r: ServiceToken): MenuItem[] => [
    { label: t("revoke"), danger: true, onSelect: () => setRevoking(r) },
  ];
  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "settings", href: "/settings/organization" },
          { label: "tokens" },
        ],
        title: t("title"),
        description: t("description"),
        actions: [{ label: t("create"), variant: "primary", onSelect: () => setCreating(true) }],
      }}
      nav={nav}
      activeNav="tokens"
    >
      <DataTable
        label={t("title")}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        state={read.kind === "ready" ? "ready" : "loading"}
        empty={{ title: t("empty"), hint: t("emptyHint") }}
        rowMenu={menu}
      />
      {creating ? (
        <CreateDialog orgId={orgId} actor={actor} onClose={() => setCreating(false)} />
      ) : null}
      {revoking !== null ? (
        <RevokeDialog
          orgId={orgId}
          token={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => setRevoking(null)}
        />
      ) : null}
    </SettingsPage>
  );
}

function CreateDialog({
  orgId,
  actor,
  onClose,
}: {
  orgId: string;
  actor: OrgRole;
  onClose(): void;
}) {
  const t = useTranslations("tokens");
  const tr = useTranslations("members.roles");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  const [name, setName] = useState("");
  const [role, setRole] = useState<ServiceTokenRole>("member");
  const [expiry, setExpiry] = useState<Expiry>("never");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const createToken = useAppMutation({
    fn: (v: Parameters<typeof createServiceToken>[1]) => createServiceToken(orgId, v),
    invalidates: () => [keys.org(orgId).serviceTokens()],
  });
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const expiresAt =
        expiry === "never"
          ? undefined
          : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
      const res = await createToken.mutateAsync({
        name: name.trim(),
        role,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      setToken(res.token);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("createTitle")}
      footer={
        token === null ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tc("cancel")}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={name.trim() === ""}
              onClick={() => void create()}
            >
              {t("createSubmit")}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {t("done")}
          </Button>
        )
      }
    >
      {token === null ? (
        <Stack gap={12}>
          <Field label={t("name")} required>
            <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("role")} help={t("roleHelp")}>
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as ServiceTokenRole)}
              // never above the actor's own role (the kernel refuses it too)
              options={SERVICE_TOKEN_ROLES.filter((r) => roleAtLeast(actor, r)).map((r) => ({
                value: r,
                label: tr(r),
              }))}
            />
          </Field>
          <Field label={t("expires")}>
            <Select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as Expiry)}
              options={EXPIRY_DAYS.map((d) => ({ value: d, label: t(`expiry.${d}`) }))}
            />
          </Field>
          {error !== null && <FormError message={error} />}
        </Stack>
      ) : (
        <SecretReveal label={t("value")} value={token} />
      )}
    </Dialog>
  );
}

function RevokeDialog({
  orgId,
  token,
  onClose,
  onDone,
}: {
  orgId: string;
  token: ServiceToken;
  onClose(): void;
  onDone(): void;
}) {
  const t = useTranslations("tokens");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revokeToken = useAppMutation({
    fn: (id: string) => revokeServiceToken(orgId, id),
    invalidates: () => [keys.org(orgId).serviceTokens()],
  });
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await revokeToken.mutateAsync(token.id);
      toast.success(t("revoked"));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("revokeTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="danger-solid" loading={busy} onClick={() => void revoke()}>
            {t("revokeConfirm")}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text variant="prose">{t("revokeDescription", { name: token.name })}</Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
