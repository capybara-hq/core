"use client";

import {
  Button,
  type Column,
  DataTable,
  Dialog,
  Field,
  Input,
  type MenuItem,
  SecretReveal,
  Select,
  SettingsPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../components/form-error";
import { RoleGate } from "../../../../components/RoleGate";
import { useOrgSettingsNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { type OrgRole, roleAtLeast } from "../../../../lib/members";
import {
  createServiceToken,
  listServiceTokens,
  revokeServiceToken,
  SERVICE_TOKEN_ROLES,
  type ServiceToken,
  type ServiceTokenRole,
} from "../../../../lib/orgs";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useLoad } from "../../../../lib/use-load";

/**
 * `/settings/tokens`: the org's service tokens (SettingsPage, group 组织; `org.tokens.manage`,
 * org admins): list, create (a role up to the actor's, optional expiry; the token is shown once)
 * and revoke after a confirmation.
 */
export default function TokensPage() {
  return (
    <RoleGate min="admin">
      {(orgId, role) => <Tokens key={orgId} orgId={orgId} actor={role} />}
    </RoleGate>
  );
}

const EXPIRY_DAYS = ["never", "30", "90", "365"] as const;
type Expiry = (typeof EXPIRY_DAYS)[number];

const date = (iso: string, locale: string) =>
  new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

function Tokens({ orgId, actor }: { orgId: string; actor: OrgRole }) {
  const scope = usePagePath("org");
  const t = useTranslations("tokens");
  const tr = useTranslations("members.roles");
  const locale = useLocale();
  const nav = useOrgSettingsNav();
  const list = useLoad(() => listServiceTokens(orgId).then((r) => r.tokens), [orgId]);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ServiceToken | null>(null);
  const rows = list.state.kind === "ready" ? list.state.data : [];
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
      cell: (r) => date(r.createdAt, locale),
    },
    {
      key: "expires",
      header: t("columns.expires"),
      tone: "muted",
      cell: (r) => (r.expiresAt === null ? t("noExpiry") : date(r.expiresAt, locale)),
    },
    {
      key: "lastUsed",
      header: t("columns.lastUsed"),
      tone: "muted",
      cell: (r) => (r.lastUsedAt === null ? t("neverUsed") : date(r.lastUsedAt, locale)),
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
        state={list.state.kind}
        error={{
          code: list.state.kind === "error" ? list.state.code : "unknown",
          onRetry: list.reload,
        }}
        empty={{ title: t("empty"), hint: t("emptyHint") }}
        rowMenu={menu}
      />
      {creating ? (
        <CreateDialog
          orgId={orgId}
          actor={actor}
          onClose={() => setCreating(false)}
          onCreated={list.reload}
        />
      ) : null}
      {revoking !== null ? (
        <RevokeDialog
          orgId={orgId}
          token={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            list.reload();
          }}
        />
      ) : null}
    </SettingsPage>
  );
}

function CreateDialog({
  orgId,
  actor,
  onClose,
  onCreated,
}: {
  orgId: string;
  actor: OrgRole;
  onClose(): void;
  onCreated(): void;
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
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const expiresAt =
        expiry === "never"
          ? undefined
          : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString();
      const res = await createServiceToken(orgId, {
        name: name.trim(),
        role,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      setToken(res.token);
      onCreated();
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
  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await revokeServiceToken(orgId, token.id);
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
        <Text>{t("revokeDescription", { name: token.name })}</Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
