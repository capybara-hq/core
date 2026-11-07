"use client";

import {
  Button,
  Checkbox,
  type Column,
  DataTable,
  Dialog,
  Field,
  Input,
  ListPage,
  Stack,
  Subsection,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AdminOrg,
  type DeploymentSettings,
  type LimitDefaults,
  parseLimit,
  SANDBOX_CPU,
  SANDBOX_MEMORY_MB,
  type SandboxLimitOverride,
  SUBAGENT_CONCURRENT,
  SUBAGENT_DEPTH,
  SUBAGENT_DISPATCHES,
  SUBAGENT_TOKENS,
  type SubagentLimitOverride,
  updateDeploymentSettings,
} from "../../../../lib/admin";
import {
  adminOrgsQuery,
  deploymentSettingsQuery,
  settingsChangeKeys,
} from "../../../../lib/query/admin";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * `/admin/orgs`：部署上的全部组织（超级管理员，ListPage）。每个组织可以覆盖运行并发上限与沙箱
 * cpu / 内存（部署设置 `runConcurrencyOverrides` / `sandboxLimitOverrides`）；留空用部署默认。
 * 沙箱限额只对之后新建的沙箱生效。组织管理员在组织设置里只读。
 * From the query cache (the layout prefetched both reads on a first load); a saved override writes
 * the answered settings into the cache.
 */
/** 运行并发：正整数（内核不设上限）。 */
const RUN_RANGE = { min: 1, max: Number.MAX_SAFE_INTEGER } as const;

/** Limit values are grouped the same in both languages (5,000,000), like the app's token counts. */
const grouped = new Intl.NumberFormat("en-US");

export default function AdminOrgsView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminOrgs />;
}

function AdminOrgs() {
  const scope = usePagePath("admin");
  const t = useTranslations("admin.orgs");
  const orgs = usePageQuery(adminOrgsQuery());
  const settings = usePageQuery(deploymentSettingsQuery());
  const [editing, setEditing] = useState<AdminOrg | null>(null);
  const header = { path: [...scope, { label: "orgs" }], title: t("title") };
  if (orgs.kind === "notFound" || settings.kind === "notFound") return <NotFound />;
  if (orgs.kind === "error") return <ErrorFrame reset={orgs.retry} />;
  if (settings.kind === "error") return <ErrorFrame reset={settings.retry} />;
  const ready = orgs.kind === "ready" && settings.kind === "ready";
  const rows = orgs.kind === "ready" ? orgs.data.orgs : [];
  const defaults = orgs.kind === "ready" ? orgs.data.limitDefaults : null;
  const s = settings.kind === "ready" ? settings.data : null;

  /**
   * An org's value, or the deployment default it falls back to: 「默认（5,000,000）」. `unlimited`:
   * the limit takes 0 for no limit (sub-agent tokens).
   */
  const orDefault = (
    v: number | undefined,
    fallback: number | undefined,
    opts: { unit?: string; unlimited?: boolean } = {},
  ) => {
    const show = (n: number) =>
      opts.unlimited === true && n === 0
        ? t("unlimited")
        : `${grouped.format(n)}${opts.unit ?? ""}`;
    if (v !== undefined) return show(v);
    return fallback === undefined ? t("default") : t("defaultValue", { value: show(fallback) });
  };

  const columns: Column<AdminOrg>[] = [
    { key: "name", header: t("columns.name"), cell: (o) => o.name },
    { key: "slug", header: t("columns.slug"), tone: "muted", cell: (o) => o.slug },
    { key: "members", header: t("columns.members"), align: "right", cell: (o) => o.memberCount },
    {
      key: "run",
      header: t("columns.runConcurrency"),
      align: "right",
      cell: (o) => orDefault(s?.runConcurrencyOverrides[o.id], defaults?.runConcurrency),
    },
    {
      key: "cpu",
      header: t("columns.cpu"),
      align: "right",
      cell: (o) => orDefault(s?.sandboxLimitOverrides[o.id]?.cpu, defaults?.sandbox.cpu),
    },
    {
      key: "memory",
      header: t("columns.memory"),
      align: "right",
      cell: (o) =>
        orDefault(s?.sandboxLimitOverrides[o.id]?.memoryMb, defaults?.sandbox.memoryMb, {
          unit: " MB",
        }),
    },
    {
      key: "subagentTokens",
      header: t("columns.subagentTokens"),
      align: "right",
      cell: (o) =>
        orDefault(
          s?.subagentLimitOverrides?.[o.id]?.maxTokensPerRun,
          defaults?.subagents.maxTokensPerRun,
          { unlimited: true },
        ),
    },
  ];

  if (!ready || s === null || defaults === null) {
    // The hint is static: it stays above the table's own loading state, as the loaded page draws
    // them (the count waits for the answer).
    return (
      <ListPage header={header}>
        <Stack gap={12}>
          <Text variant="prose" tone="muted">
            {t("hint")}
          </Text>
          <DataTable
            label={t("title")}
            columns={columns}
            rows={[]}
            rowKey={(o) => o.id}
            state="loading"
          />
        </Stack>
      </ListPage>
    );
  }

  return (
    <ListPage header={{ path: header.path, title: header.title, count: String(rows.length) }}>
      <Stack gap={12}>
        {/* One paragraph: the admin console sets deployment-level limits; inside an org only its
            admins act */}
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
        <DataTable
          label={t("title")}
          columns={columns}
          rows={rows}
          rowKey={(o) => o.id}
          state="ready"
          empty={{ title: t("empty") }}
          rowMenu={(o) => [{ label: t("edit"), onSelect: () => setEditing(o) }]}
        />
      </Stack>
      {editing !== null && (
        <LimitsDialog
          org={editing}
          settings={s}
          defaults={defaults}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </ListPage>
  );
}

/**
 * 一个组织的运行并发与沙箱限额；留空 = 部署默认（发 null 删除覆盖）。Each input's placeholder is the
 * deployment default; sub-agent dispatches and tokens also take 「不限制」 (saved as 0).
 */
function LimitsDialog({
  org,
  settings,
  defaults,
  onClose,
  onSaved,
}: {
  org: AdminOrg;
  settings: DeploymentSettings;
  defaults: LimitDefaults;
  onClose(): void;
  onSaved(): void;
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
  const [depth, setDepth] = useState(text(subagent?.maxDepth));
  const [concurrent, setConcurrent] = useState(text(subagent?.maxConcurrentPerConversation));
  // 0 is no limit: the checkbox, not the text
  const limitText = (v: number | undefined) => (v === 0 ? "" : text(v));
  const [dispatches, setDispatches] = useState(limitText(subagent?.maxDispatchesPerRun));
  const [dispatchesUnlimited, setDispatchesUnlimited] = useState(
    subagent?.maxDispatchesPerRun === 0,
  );
  const [tokens, setTokens] = useState(limitText(subagent?.maxTokensPerRun));
  const [tokensUnlimited, setTokensUnlimited] = useState(subagent?.maxTokensPerRun === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  // The answer is the settings as they are now: it replaces the cached ones.
  const update = useAppMutation({
    fn: updateDeploymentSettings,
    invalidates: (patch) => settingsChangeKeys(patch),
    onSuccess: (r) => qc.setQueryData(deploymentSettingsQuery().queryKey, r),
  });

  const runValue = parseLimit(run, RUN_RANGE, true);
  const cpuValue = parseLimit(cpu, SANDBOX_CPU, false);
  const memoryValue = parseLimit(memory, SANDBOX_MEMORY_MB, true);
  const depthValue = parseLimit(depth, SUBAGENT_DEPTH, true);
  const concurrentValue = parseLimit(concurrent, SUBAGENT_CONCURRENT, true);
  const dispatchesValue = dispatchesUnlimited
    ? 0
    : parseLimit(dispatches, SUBAGENT_DISPATCHES, true);
  const tokensValue = tokensUnlimited ? 0 : parseLimit(tokens, SUBAGENT_TOKENS, true);
  /** The placeholder: the deployment default the empty field falls back to. */
  const placeholder = (n: number, unlimited = false) =>
    t("placeholder", {
      value: unlimited && n === 0 ? tOrgs("unlimited") : grouped.format(n),
    });
  const valid =
    runValue !== "invalid" &&
    cpuValue !== "invalid" &&
    memoryValue !== "invalid" &&
    depthValue !== "invalid" &&
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
      ...(depthValue !== null && { maxDepth: depthValue }),
      ...(concurrentValue !== null && { maxConcurrentPerConversation: concurrentValue }),
      ...(dispatchesValue !== null && { maxDispatchesPerRun: dispatchesValue }),
      ...(tokensValue !== null && { maxTokensPerRun: tokensValue }),
    };
    // sent only when changed (a kernel before phase C does not know the key)
    const subagentChanged = JSON.stringify(subagentLimits) !== JSON.stringify(subagent ?? {});
    setBusy(true);
    setError(null);
    try {
      await update.mutateAsync({
        runConcurrencyOverrides: { [org.id]: runValue },
        sandboxLimitOverrides: { [org.id]: Object.keys(limits).length > 0 ? limits : null },
        ...(subagentChanged && {
          subagentLimitOverrides: {
            [org.id]: Object.keys(subagentLimits).length > 0 ? subagentLimits : null,
          },
        }),
      });
      toast.success(tOrgs("saved"));
      onSaved();
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
      {/* The Dialog is the one box (spec §6.7): 运行, 沙箱, 子智能体 as titled regions */}
      <Stack gap={16}>
        <Text variant="prose" tone="muted">
          {t("emptyDefault")}
        </Text>
        <Subsection title={t("groups.run")} variant="divided">
          <Field
            label={t("runConcurrency")}
            help={t("runConcurrencyHelp")}
            {...(runValue === "invalid" && { error: t("runConcurrencyInvalid") })}
          >
            <Input
              inputMode="numeric"
              value={run}
              placeholder={placeholder(defaults.runConcurrency)}
              onChange={(e) => setRun(e.target.value)}
            />
          </Field>
        </Subsection>
        <Subsection title={t("groups.sandbox")} description={t("newOnly")} variant="divided">
          <Field
            label={t("cpu")}
            help={t("cpuHelp")}
            {...(cpuValue === "invalid" && { error: t("cpuInvalid") })}
          >
            <Input
              inputMode="decimal"
              value={cpu}
              placeholder={placeholder(defaults.sandbox.cpu)}
              onChange={(e) => setCpu(e.target.value)}
            />
          </Field>
          <Field
            label={t("memory")}
            help={t("memoryHelp")}
            {...(memoryValue === "invalid" && { error: t("memoryInvalid") })}
          >
            <Input
              inputMode="numeric"
              value={memory}
              placeholder={placeholder(defaults.sandbox.memoryMb)}
              onChange={(e) => setMemory(e.target.value)}
            />
          </Field>
        </Subsection>
        <Subsection title={t("groups.subagents")} variant="divided">
          <Field
            label={t("subagentDepth")}
            help={t("subagentDepthHelp")}
            {...(depthValue === "invalid" && { error: t("subagentDepthInvalid") })}
          >
            <Input
              inputMode="numeric"
              value={depth}
              placeholder={placeholder(defaults.subagents.maxDepth)}
              onChange={(e) => setDepth(e.target.value)}
            />
          </Field>
          <Field
            label={t("subagentConcurrent")}
            help={t("subagentConcurrentHelp")}
            {...(concurrentValue === "invalid" && { error: t("subagentConcurrentInvalid") })}
          >
            <Input
              inputMode="numeric"
              value={concurrent}
              placeholder={placeholder(defaults.subagents.maxConcurrentPerConversation)}
              onChange={(e) => setConcurrent(e.target.value)}
            />
          </Field>
          <Stack gap={8}>
            <Field
              label={t("subagentDispatches")}
              help={t("subagentDispatchesHelp")}
              {...(dispatchesValue === "invalid" && { error: t("subagentDispatchesInvalid") })}
            >
              <Input
                inputMode="numeric"
                value={dispatchesUnlimited ? "" : dispatches}
                disabled={dispatchesUnlimited}
                placeholder={
                  dispatchesUnlimited
                    ? tOrgs("unlimited")
                    : placeholder(defaults.subagents.maxDispatchesPerRun, true)
                }
                onChange={(e) => setDispatches(e.target.value)}
              />
            </Field>
            <Checkbox
              checked={dispatchesUnlimited}
              onChange={setDispatchesUnlimited}
              label={t("unlimited")}
            />
          </Stack>
          <Stack gap={8}>
            <Field
              label={t("subagentTokens")}
              help={t("subagentTokensHelp")}
              {...(tokensValue === "invalid" && { error: t("subagentTokensInvalid") })}
            >
              <Input
                inputMode="numeric"
                value={tokensUnlimited ? "" : tokens}
                disabled={tokensUnlimited}
                placeholder={
                  tokensUnlimited
                    ? tOrgs("unlimited")
                    : placeholder(defaults.subagents.maxTokensPerRun, true)
                }
                onChange={(e) => setTokens(e.target.value)}
              />
            </Field>
            <Checkbox
              checked={tokensUnlimited}
              onChange={setTokensUnlimited}
              label={t("unlimited")}
            />
          </Stack>
        </Subsection>
        {error !== null && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
