"use client";

import {
  Button,
  type Column,
  DataTable,
  Dialog,
  Field,
  Input,
  ListPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AdminGate } from "../../../../../components/AdminGate";
import { useAdminBreadcrumb } from "../../../../../components/admin-nav";
import { FormError } from "../../../../../components/form-error";
import {
  type AdminOrg,
  type DeploymentSettings,
  getDeploymentSettings,
  listAdminOrgs,
  parseLimit,
  SANDBOX_CPU,
  SANDBOX_MEMORY_MB,
  type SandboxLimitOverride,
  SUBAGENT_CONCURRENT,
  SUBAGENT_DISPATCHES,
  SUBAGENT_TOKENS,
  type SubagentLimitOverride,
  updateDeploymentSettings,
} from "../../../../../lib/admin";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/admin/orgs`：部署上的全部组织（企业管理员，ListPage）。每个组织可以覆盖运行并发上限与沙箱
 * cpu / 内存（部署设置 `runConcurrencyOverrides` / `sandboxLimitOverrides`）；留空用部署默认。
 * 沙箱限额只对之后新建的沙箱生效。组织管理员在组织设置里只读。
 */
export default function AdminOrgsPage() {
  return (
    <AdminGate>
      <AdminOrgs />
    </AdminGate>
  );
}

/** 运行并发：正整数（内核不设上限）。 */
const RUN_RANGE = { min: 1, max: Number.MAX_SAFE_INTEGER } as const;

function AdminOrgs() {
  const t = useTranslations("admin.orgs");
  const breadcrumb = useAdminBreadcrumb();
  const orgs = useLoad(listAdminOrgs, []);
  const settings = useLoad(getDeploymentSettings, []);
  const [editing, setEditing] = useState<AdminOrg | null>(null);

  const s = settings.state.kind === "ready" ? settings.state.data : undefined;
  const rows = orgs.state.kind === "ready" ? orgs.state.data.orgs : [];
  const failed =
    orgs.state.kind === "error"
      ? orgs.state
      : settings.state.kind === "error"
        ? settings.state
        : null;
  const state = failed
    ? "error"
    : s === undefined || orgs.state.kind !== "ready"
      ? "loading"
      : "ready";
  const orDefault = (v: number | undefined, unit = "") =>
    v === undefined ? t("default") : `${v}${unit}`;

  const columns: Column<AdminOrg>[] = [
    { key: "name", header: t("columns.name"), cell: (o) => o.name },
    { key: "slug", header: t("columns.slug"), tone: "muted", cell: (o) => o.slug },
    { key: "members", header: t("columns.members"), align: "right", cell: (o) => o.memberCount },
    {
      key: "run",
      header: t("columns.runConcurrency"),
      align: "right",
      cell: (o) => orDefault(s?.runConcurrencyOverrides[o.id]),
    },
    {
      key: "cpu",
      header: t("columns.cpu"),
      align: "right",
      cell: (o) => orDefault(s?.sandboxLimitOverrides[o.id]?.cpu),
    },
    {
      key: "memory",
      header: t("columns.memory"),
      align: "right",
      cell: (o) => orDefault(s?.sandboxLimitOverrides[o.id]?.memoryMb, " MB"),
    },
  ];

  return (
    <ListPage header={{ breadcrumb, title: t("title"), count: String(rows.length) }}>
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(o) => o.id}
          state={state}
          error={{
            code: failed?.code ?? "unknown",
            onRetry: () => {
              orgs.reload();
              settings.reload();
            },
          }}
          empty={{ title: t("empty") }}
          rowMenu={(o) => [{ label: t("edit"), onSelect: () => setEditing(o) }]}
        />
      </Stack>
      {editing !== null && s !== undefined && (
        <LimitsDialog
          org={editing}
          settings={s}
          onClose={() => setEditing(null)}
          onSaved={(next) => {
            settings.set(next);
            setEditing(null);
          }}
        />
      )}
    </ListPage>
  );
}

/** 一个组织的运行并发与沙箱限额；留空 = 部署默认（发 null 删除覆盖）。 */
function LimitsDialog({
  org,
  settings,
  onClose,
  onSaved,
}: {
  org: AdminOrg;
  settings: DeploymentSettings;
  onClose(): void;
  onSaved(next: DeploymentSettings): void;
}) {
  const t = useTranslations("admin.orgs.dialog");
  const tc = useTranslations("common");
  const tOrgs = useTranslations("admin.orgs");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const sandbox = settings.sandboxLimitOverrides[org.id];
  const text = (v: number | undefined) => (v === undefined ? "" : String(v));
  const [run, setRun] = useState(text(settings.runConcurrencyOverrides[org.id]));
  const [cpu, setCpu] = useState(text(sandbox?.cpu));
  const [memory, setMemory] = useState(text(sandbox?.memoryMb));
  const subagent = settings.subagentLimitOverrides?.[org.id];
  const [concurrent, setConcurrent] = useState(text(subagent?.maxConcurrentPerRun));
  const [dispatches, setDispatches] = useState(text(subagent?.maxDispatchesPerRun));
  const [tokens, setTokens] = useState(text(subagent?.maxTokensPerRun));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runValue = parseLimit(run, RUN_RANGE, true);
  const cpuValue = parseLimit(cpu, SANDBOX_CPU, false);
  const memoryValue = parseLimit(memory, SANDBOX_MEMORY_MB, true);
  const concurrentValue = parseLimit(concurrent, SUBAGENT_CONCURRENT, true);
  const dispatchesValue = parseLimit(dispatches, SUBAGENT_DISPATCHES, true);
  const tokensValue = parseLimit(tokens, SUBAGENT_TOKENS, true);
  const valid =
    runValue !== "invalid" &&
    cpuValue !== "invalid" &&
    memoryValue !== "invalid" &&
    concurrentValue !== "invalid" &&
    dispatchesValue !== "invalid" &&
    tokensValue !== "invalid";

  const save = async () => {
    if (!valid) return;
    const limits: SandboxLimitOverride = {
      ...(cpuValue !== null && { cpu: cpuValue }),
      ...(memoryValue !== null && { memoryMb: memoryValue }),
    };
    const subagentLimits: SubagentLimitOverride = {
      ...(concurrentValue !== null && { maxConcurrentPerRun: concurrentValue }),
      ...(dispatchesValue !== null && { maxDispatchesPerRun: dispatchesValue }),
      ...(tokensValue !== null && { maxTokensPerRun: tokensValue }),
    };
    // sent only when changed (a kernel before phase C does not know the key)
    const subagentChanged = JSON.stringify(subagentLimits) !== JSON.stringify(subagent ?? {});
    setBusy(true);
    setError(null);
    try {
      const next = await updateDeploymentSettings({
        runConcurrencyOverrides: { [org.id]: runValue },
        sandboxLimitOverrides: { [org.id]: Object.keys(limits).length > 0 ? limits : null },
        ...(subagentChanged && {
          subagentLimitOverrides: {
            [org.id]: Object.keys(subagentLimits).length > 0 ? subagentLimits : null,
          },
        }),
      });
      toast.success(tOrgs("saved"));
      onSaved(next);
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
      title={t("title", { name: org.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save()}>
            {t("save")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Field
          label={t("runConcurrency")}
          help={t("runConcurrencyHelp")}
          {...(runValue === "invalid" && { error: t("runConcurrencyInvalid") })}
        >
          <Input inputMode="numeric" value={run} onChange={(e) => setRun(e.target.value)} />
        </Field>
        <Field
          label={t("cpu")}
          help={t("cpuHelp")}
          {...(cpuValue === "invalid" && { error: t("cpuInvalid") })}
        >
          <Input inputMode="decimal" value={cpu} onChange={(e) => setCpu(e.target.value)} />
        </Field>
        <Field
          label={t("memory")}
          help={t("memoryHelp")}
          {...(memoryValue === "invalid" && { error: t("memoryInvalid") })}
        >
          <Input inputMode="numeric" value={memory} onChange={(e) => setMemory(e.target.value)} />
        </Field>
        <Text variant="small" tone="muted">
          {t("newOnly")}
        </Text>
        <Field
          label={t("subagentConcurrent")}
          help={t("subagentConcurrentHelp")}
          {...(concurrentValue === "invalid" && { error: t("subagentConcurrentInvalid") })}
        >
          <Input
            inputMode="numeric"
            value={concurrent}
            onChange={(e) => setConcurrent(e.target.value)}
          />
        </Field>
        <Field
          label={t("subagentDispatches")}
          help={t("subagentDispatchesHelp")}
          {...(dispatchesValue === "invalid" && { error: t("subagentDispatchesInvalid") })}
        >
          <Input
            inputMode="numeric"
            value={dispatches}
            onChange={(e) => setDispatches(e.target.value)}
          />
        </Field>
        <Field
          label={t("subagentTokens")}
          help={t("subagentTokensHelp")}
          {...(tokensValue === "invalid" && { error: t("subagentTokensInvalid") })}
        >
          <Input inputMode="numeric" value={tokens} onChange={(e) => setTokens(e.target.value)} />
        </Field>
        <Text variant="small" tone="muted">
          {t("e2bNote")}
        </Text>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
