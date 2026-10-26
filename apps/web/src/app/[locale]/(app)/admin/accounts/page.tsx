"use client";

import {
  Badge,
  Button,
  Checkbox,
  type Column,
  DataTable,
  Dialog,
  Field,
  Input,
  ListPage,
  Stack,
  StatusMark,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AdminGate } from "../../../../../components/AdminGate";
import { useAdminBreadcrumb } from "../../../../../components/admin-nav";
import { FormError } from "../../../../../components/form-error";
import {
  type AccountPatch,
  type AdminAccount,
  createAdminAccount,
  listAdminAccounts,
  updateAdminAccount,
} from "../../../../../lib/admin";
import { ApiClientError } from "../../../../../lib/api";
import { useErrorMessage } from "../../../../../lib/use-error-message";

/**
 * `/[locale]/admin/accounts`：部署上的全部账号（企业管理员，ListPage）。新建账号；停用 / 启用；
 * 授予或撤销「企业管理员」。改动前一律二次确认（撤销最后一个企业管理员由内核拒绝，错误显示在确认框里）。
 */
export default function AdminAccountsPage() {
  return (
    <AdminGate>
      <AdminAccounts />
    </AdminGate>
  );
}

/** 待确认的改动。 */
type Pending = { account: AdminAccount; action: "grant" | "revoke" | "disable" | "enable" };

const PATCH: Record<Pending["action"], AccountPatch> = {
  grant: { isEnterpriseAdmin: true },
  revoke: { isEnterpriseAdmin: false },
  disable: { status: "disabled" },
  enable: { status: "active" },
};

function AdminAccounts() {
  const t = useTranslations("admin.accounts");
  const breadcrumb = useAdminBreadcrumb();
  const errorMessage = useErrorMessage();
  const [rows, setRows] = useState<AdminAccount[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [errorCode, setErrorCode] = useState("unknown");
  const [loadingMore, setLoadingMore] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async (after?: string) => {
    const page = await listAdminAccounts(after);
    setRows((prev) => (after === undefined ? page.accounts : [...prev, ...page.accounts]));
    setNext(page.next);
  }, []);

  const reload = useCallback(() => {
    setState("loading");
    load().then(
      () => setState("ready"),
      (e: unknown) => {
        setErrorCode(e instanceof ApiClientError ? e.code : "unknown");
        setState("error");
      },
    );
  }, [load]);

  useEffect(() => reload(), [reload]);

  const replace = (a: AdminAccount) => setRows((rs) => rs.map((r) => (r.id === a.id ? a : r)));

  const columns: Column<AdminAccount>[] = [
    { key: "name", header: t("columns.name"), cell: (a) => a.displayName },
    { key: "email", header: t("columns.email"), tone: "muted", cell: (a) => a.email ?? "—" },
    {
      key: "status",
      header: t("columns.status"),
      cell: (a) =>
        a.status === "active" ? (
          <StatusMark status="success" label={t("status.active")} />
        ) : (
          <StatusMark status="cancelled" label={t("status.disabled")} />
        ),
    },
    {
      key: "role",
      header: t("columns.role"),
      cell: (a) => (a.isEnterpriseAdmin ? <Badge tone="accent">{t("enterpriseAdmin")}</Badge> : ""),
    },
  ];

  return (
    <ListPage
      header={{
        breadcrumb,
        title: t("title"),
        count: state === "ready" ? String(rows.length) + (next === null ? "" : "+") : undefined,
        actions: [{ label: t("new"), variant: "primary", onSelect: () => setCreating(true) }],
      }}
    >
      <Stack gap={12}>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          state={state}
          error={{ code: errorCode, onRetry: reload }}
          empty={{ title: t("empty") }}
          isDisabled={(a) => a.status === "disabled"}
          rowMenu={(a) => [
            a.isEnterpriseAdmin
              ? {
                  label: t("menu.revoke"),
                  onSelect: () => setPending({ account: a, action: "revoke" }),
                }
              : {
                  label: t("menu.grant"),
                  onSelect: () => setPending({ account: a, action: "grant" }),
                },
            a.status === "active"
              ? {
                  label: t("menu.disable"),
                  danger: true,
                  onSelect: () => setPending({ account: a, action: "disable" }),
                }
              : {
                  label: t("menu.enable"),
                  onSelect: () => setPending({ account: a, action: "enable" }),
                },
          ]}
        />
        {next !== null && state === "ready" && (
          <Stack direction="row">
            <Button
              loading={loadingMore}
              onClick={() => {
                setLoadingMore(true);
                load(next)
                  .catch(() => {})
                  .finally(() => setLoadingMore(false));
              }}
            >
              {t("loadMore")}
            </Button>
          </Stack>
        )}
      </Stack>
      {pending !== null && (
        <ConfirmDialog
          pending={pending}
          onClose={() => setPending(null)}
          onDone={(a) => {
            replace(a);
            setPending(null);
          }}
          errorMessage={errorMessage}
        />
      )}
      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(a) => {
            setRows((rs) => [...rs, a]);
            setCreating(false);
          }}
        />
      )}
    </ListPage>
  );
}

/** 停用 / 启用 / 授予 / 撤销企业管理员的二次确认。 */
function ConfirmDialog({
  pending,
  onClose,
  onDone,
  errorMessage,
}: {
  pending: Pending;
  onClose(): void;
  onDone(a: AdminAccount): void;
  errorMessage(e: unknown): string;
}) {
  const t = useTranslations("admin.accounts");
  const tc = useTranslations("common");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { account, action } = pending;
  const name = account.displayName;
  const danger = action === "revoke" || action === "disable";

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { account: updated } = await updateAdminAccount(account.id, PATCH[action]);
      toast.success(t(`done.${action}`, { name }));
      onDone(updated);
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
      title={t(`confirm.${action}Title`, { name })}
      danger={danger}
      initialFocus="cancel"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button
            variant={danger ? "danger-solid" : "primary"}
            loading={busy}
            onClick={() => void confirm()}
          >
            {t(`confirm.${action}`)}
          </Button>
        </>
      }
    >
      <Stack gap={8}>
        <Text>{t(`confirm.${action}Hint`, { name })}</Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}

/** 新建本地账号（可同时设为企业管理员）。 */
function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(a: AdminAccount): void;
}) {
  const t = useTranslations("admin.accounts.form");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [enterpriseAdmin, setEnterpriseAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = login.trim() !== "" && password !== "" && displayName.trim() !== "";

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { account } = await createAdminAccount({
        login: login.trim(),
        password,
        displayName: displayName.trim(),
        ...(email.trim() !== "" && { email: email.trim() }),
        enterpriseAdmin,
      });
      toast.success(t("created", { name: account.displayName }));
      onCreated(account);
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
      title={t("title")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
            {t("submit")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Field label={t("login")} required>
          <Input value={login} autoComplete="off" onChange={(e) => setLogin(e.target.value)} />
        </Field>
        <Field label={t("password")} required help={t("passwordHelp")}>
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label={t("displayName")} required>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label={t("email")} optional>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Checkbox
          checked={enterpriseAdmin}
          onChange={setEnterpriseAdmin}
          label={t("enterpriseAdmin")}
        />
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
