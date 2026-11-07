"use client";

import {
  Button,
  type Column,
  DataTable,
  EmptyState,
  Field,
  FormSection,
  Input,
  ListPage,
  LoadingSubsection,
  Stack,
  Subsection,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { NoAccess } from "../../../../components/NoAccess";
import { usePurposeDrafts } from "../../../../components/PurposeEditor";
import { usePagePath } from "../../../../components/shell/path";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  type AdminModelInfo,
  type AdminModels,
  type AdminProvider,
  encodeModel,
  findPrice,
  type ModelPrice,
  type PurposeTarget,
  type PurposeView,
  parsePrice,
  putAdminPurpose,
  putModelPrice,
} from "../../../../lib/models";
import { adminModelsQuery, adminPurposesQuery } from "../../../../lib/query/admin";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import type { Me } from "../../../../lib/session";
import { useErrorMessage } from "../../../../lib/use-error-message";
import NotFound from "../../not-found";

/**
 * A price change: the answer is the whole price table, which replaces the cached one (the
 * providers and their models stay).
 */
function usePutPrice() {
  const qc = useQueryClient();
  return useAppMutation({
    fn: putModelPrice,
    invalidates: () => [],
    onSuccess: (r) =>
      qc.setQueryData<AdminModels>(adminModelsQuery().queryKey, (d) =>
        d === undefined ? d : { ...d, ...r },
      ),
  });
}

/**
 * The purposes while they load, as PurposeEditor draws them at the deployment scope: the kernel's
 * six (eval, title, web extraction and the three sub-agent tiers), each a row with its one hint
 * (what happens while it is unset) over the model select.
 */
const LOADING_PURPOSES = [1, 1, 1, 1, 1, 1].map((lines) => ({
  lines,
  lineSize: "small" as const,
  field: { control: "select" as const },
}));

/**
 * `/admin/models`：模型（超级管理员，ListPage，no inner nav：the sidebar's admin context navigates）。
 * - 供应商与模型：每个供应商一张表（能力、上下文长度、每百万 token 的价格，行内编辑 / 清除价格）；
 *   列模型失败的供应商只显示错误，不影响其他供应商；
 * - 用途默认映射：每个用途一行（部署默认，各组织可在 `/settings/models` 覆盖）；插件声明的用途旁注
 *   「插件调用模型尚未开放」；`eval` 未映射时它那一行提示评测不能开评委。
 * From the query cache (the layout prefetched both reads on a first load); a saved price or purpose
 * is written into the cache.
 */
export default function AdminModelsView() {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminModelsRead me={gate.me} />;
}

function AdminModelsRead({ me }: { me: Me }) {
  const scope = usePagePath("admin");
  const t = useTranslations("models");
  const models = usePageQuery(adminModelsQuery());
  const purposes = usePageQuery(adminPurposesQuery());
  const header = { path: [...scope, { label: "models" }], title: t("admin.title") };
  if (models.kind === "notFound" || purposes.kind === "notFound") return <NotFound />;
  if (models.kind === "error") return <ErrorFrame reset={models.retry} />;
  if (purposes.kind === "error") return <ErrorFrame reset={purposes.retry} />;
  if (models.kind === "loading" || purposes.kind === "loading") {
    // The two sections are static: the providers (one provider's table while it loads, running to
    // the card's edges; the provider names come with the data) and the kernel's purposes as rows.
    return (
      <ListPage header={header} loading={{ keep: true }}>
        <FormSection
          id="providers"
          flush
          title={t("admin.providers.title")}
          description={
            models.kind === "ready"
              ? t("admin.providers.description", { currency: models.data.currency })
              : t("admin.providers.description", { currency: "…" })
          }
        >
          {/* The heading row is there too (its title comes with the data): nothing jumps */}
          <LoadingSubsection variant="flush">
            <DataTable<AdminModelInfo>
              label={t("admin.providers.title")}
              // The loaded table's header (its cells come with the data).
              columns={(
                [
                  "model",
                  "capabilities",
                  "context",
                  "input",
                  "output",
                  "cacheRead",
                  "cacheWrite",
                ] as const
              ).map((key) => ({ key, header: t(`admin.columns.${key}`), cell: () => null }))}
              rows={[]}
              rowKey={(m) => m.id}
              state="loading"
            />
          </LoadingSubsection>
        </FormSection>
        <FormSection
          id="purposes"
          title={t("admin.purposes.title")}
          description={t("admin.purposes.description")}
          loading={{ items: LOADING_PURPOSES }}
        />
      </ListPage>
    );
  }
  return (
    <ModelsBody
      header={header}
      data={{ ...models.data, purposes: purposes.data.purposes }}
      orgId={me.currentOrgId}
    />
  );
}

function ModelsBody({
  header,
  data,
  orgId,
}: {
  header: { path: { label: string; href?: string }[]; title: string };
  data: AdminModels & { purposes: PurposeView[] };
  orgId: string | null;
}) {
  const t = useTranslations("models");
  const qc = useQueryClient();
  const okProviders = data.providers.filter((p) => p.status === "ok");
  // The answer is the saved purpose: it replaces that purpose in the cache (a functional update:
  // the ActionRow saves several purposes at once). The current org's purposes show the deployment
  // default, so they are read again.
  const put = useAppMutation({
    fn: (v: { purpose: string; target: PurposeTarget | null }) =>
      putAdminPurpose(v.purpose, v.target),
    invalidates: () => (orgId === null ? [] : [keys.org(orgId).orgPurposes()]),
  });
  const replacePurpose = (v: PurposeView) =>
    qc.setQueryData<{ purposes: PurposeView[] }>(adminPurposesQuery().queryKey, (d) =>
      d === undefined
        ? d
        : { ...d, purposes: d.purposes.map((p) => (p.purpose === v.purpose ? v : p)) },
    );
  const { list, actionRow } = usePurposeDrafts({
    purposes: data.purposes,
    providers: okProviders,
    scope: "deployment",
    save: (purpose, target) => put.mutateAsync({ purpose, target }).then((r) => r.purpose),
    onSaved: replacePurpose,
  });
  const body = (
    <>
      {/* One card of providers (spec §6.6): each provider a flush Subsection over its table */}
      <FormSection
        id="providers"
        flush
        title={t("admin.providers.title")}
        description={t("admin.providers.description", { currency: data.currency })}
      >
        {data.providers.length === 0 ? (
          <EmptyState size="compact" text={t("admin.noProviders")} />
        ) : (
          data.providers.map((p) => <ProviderModels key={p.provider} provider={p} data={data} />)
        )}
      </FormSection>
      <FormSection
        id="purposes"
        title={t("admin.purposes.title")}
        description={t("admin.purposes.description")}
        flush
      >
        {list(t("admin.purposes.title"))}
      </FormSection>
    </>
  );

  return (
    <ListPage header={header} {...(actionRow !== undefined ? { actionRow } : {})}>
      {body}
    </ListPage>
  );
}

/** 一个供应商：一个 flush Subsection，标题 + 模型表（或列模型失败的错误）。 */
function ProviderModels({ provider: p, data }: { provider: AdminProvider; data: AdminModels }) {
  const t = useTranslations("models");
  const locale = useLocale();
  const providerName = extensionLabel(
    { name: p.provider, displayName: p.displayName },
    labelLocale(locale),
  );
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [editing, setEditing] = useState<string>();
  const putPrice = usePutPrice();
  const grouped = new Intl.NumberFormat(locale);
  const num = (n: number) => grouped.format(n);
  const priceOf = (m: AdminModelInfo) => findPrice(data.prices, p.provider, m.id);
  const keyOf = (m: AdminModelInfo) => encodeModel({ provider: p.provider, model: m.id });

  async function clear(m: AdminModelInfo) {
    try {
      await putPrice.mutateAsync({ provider: p.provider, model: m.id, price: null });
      toast.success(t("admin.price.cleared", { model: m.displayName }));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const CAPS = ["tools", "vision", "documents", "reasoning", "caching"] as const;
  const columns: Column<AdminModelInfo>[] = [
    {
      key: "model",
      header: t("admin.columns.model"),
      // A minimum for the names (「deepseek/deepseek-chat」 is not cut to 「deepseek/dee」)
      width: 240,
      cell: (m) => (
        <Stack gap={0}>
          <Text>{m.displayName}</Text>
          {m.displayName !== m.id ? (
            <Text variant="small" tone="muted">
              {m.id}
            </Text>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "capabilities",
      header: t("admin.columns.capabilities"),
      tone: "muted",
      // Plain text, not badges (「工具 · 缓存」), and never cut: it wraps instead of an ellipsis
      wrap: true,
      // A list: DataTable joins it with 「 · 」 and breaks lines only between items
      cell: (m) => CAPS.filter((c) => m.capabilities[c] === true).map((c) => t(`capability.${c}`)),
    },
    {
      key: "context",
      header: t("admin.columns.context"),
      align: "right",
      cell: (m) => num(m.contextWindow),
    },
    {
      key: "input",
      header: t("admin.columns.input"),
      // Narrow: the mono figures fit, so the table fits the content width
      width: 80,
      align: "right",
      cell: (m) => {
        const pr = priceOf(m);
        return pr === undefined ? "—" : num(pr.inputPerMTok);
      },
    },
    {
      key: "output",
      header: t("admin.columns.output"),
      // Narrow: the mono figures fit, so the table fits the content width
      width: 80,
      align: "right",
      cell: (m) => {
        const pr = priceOf(m);
        return pr === undefined ? "—" : num(pr.outputPerMTok);
      },
    },
    ...(["cacheRead", "cacheWrite"] as const).map(
      (k): Column<AdminModelInfo> => ({
        key: k,
        header: t(`admin.columns.${k}`),
        // Narrow: the mono figures fit, so the table fits the content width
        width: 80,
        align: "right",
        tone: "muted",
        cell: (m) => {
          const pr = priceOf(m);
          if (pr === undefined) return "—";
          const v = k === "cacheRead" ? pr.cacheReadPerMTok : pr.cacheWritePerMTok;
          return v === null ? t("admin.sameAsInput") : num(v);
        },
      }),
    ),
  ];

  // The provider's id under its name when the name is not the id (plain metadata, mono muted);
  // a provider that failed to list its models shows its error there, in place of its table (a
  // block: the message in body size, each detail on its own row).
  const id = p.displayName ? p.provider : p.plugin !== p.provider ? p.plugin : undefined;
  const failed = p.status === "error";
  const description = failed ? (
    <Stack gap={4}>
      {id !== undefined ? (
        <Text variant="small" tone="muted">
          {id}
        </Text>
      ) : null}
      <FormError
        message={t("admin.providerError", { provider: providerName })}
        extra={p.error === undefined ? [] : [p.error]}
      />
    </Stack>
  ) : id !== undefined ? (
    <Text variant="small" tone="muted">
      {id}
    </Text>
  ) : undefined;

  return (
    <Subsection
      variant="flush"
      title={providerName}
      {...(description !== undefined ? { description } : {})}
    >
      {failed ? null : (
        <DataTable
          label={providerName}
          columns={columns}
          rows={p.models}
          rowKey={keyOf}
          empty={{ title: t("admin.noModels") }}
          rowMenu={(m) => [
            {
              label: t("admin.menu.editPrice"),
              onSelect: () => setEditing(keyOf(m)),
            },
            ...(priceOf(m) === undefined
              ? []
              : [
                  "separator" as const,
                  {
                    label: t("admin.menu.clearPrice"),
                    danger: true,
                    onSelect: () => void clear(m),
                  },
                ]),
          ]}
          expand={(m) =>
            editing === keyOf(m) ? (
              <PriceEditor
                provider={p.provider}
                model={m}
                price={priceOf(m)}
                onCancel={() => setEditing(undefined)}
                onSaved={() => setEditing(undefined)}
              />
            ) : null
          }
        />
      )}
    </Subsection>
  );
}

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type PriceField = (typeof PRICE_FIELDS)[number];

/** 行内的价格编辑：输入 / 输出必填，缓存读 / 写留空按输入价计；单价 0..1e6。 */
function PriceEditor({
  provider,
  model,
  price,
  onCancel,
  onSaved,
}: {
  provider: string;
  model: AdminModelInfo;
  price: ModelPrice | undefined;
  onCancel(): void;
  onSaved(): void;
}) {
  const t = useTranslations("models.admin.price");
  const putPrice = usePutPrice();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const initial = (v: number | null | undefined) =>
    v === null || v === undefined ? "" : String(v);
  const [draft, setDraft] = useState<Record<PriceField, string>>({
    input: initial(price?.inputPerMTok),
    output: initial(price?.outputPerMTok),
    cacheRead: initial(price?.cacheReadPerMTok),
    cacheWrite: initial(price?.cacheWritePerMTok),
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const parsed = Object.fromEntries(PRICE_FIELDS.map((f) => [f, parsePrice(draft[f])])) as Record<
    PriceField,
    number | null | "invalid"
  >;
  const invalid = PRICE_FIELDS.some((f) => parsed[f] === "invalid");
  const input = parsed.input;
  const output = parsed.output;
  const canSave = !invalid && typeof input === "number" && typeof output === "number";

  async function save() {
    if (typeof input !== "number" || typeof output !== "number") return;
    const cache = (v: number | null | "invalid") => (typeof v === "number" ? v : null);
    setPending(true);
    setError(undefined);
    try {
      await putPrice.mutateAsync({
        provider,
        model: model.id,
        inputPerMTok: input,
        outputPerMTok: output,
        cacheReadPerMTok: cache(parsed.cacheRead),
        cacheWritePerMTok: cache(parsed.cacheWrite),
      });
      toast.success(t("saved", { model: model.displayName }));
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  return (
    <Stack gap={12}>
      <Stack direction="row" gap={12} wrap>
        {PRICE_FIELDS.map((f) => (
          <Field
            key={f}
            label={t(f)}
            {...(f === "cacheRead" || f === "cacheWrite" ? { help: t("cacheHint") } : {})}
            {...(parsed[f] === "invalid" ? { error: t("invalid") } : {})}
          >
            <Input
              inputMode="decimal"
              value={draft[f]}
              disabled={pending}
              onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
            />
          </Field>
        ))}
      </Stack>
      {error !== undefined ? <FormError message={error} /> : null}
      <Stack direction="row" gap={8}>
        <Button
          variant="secondary"
          loading={pending}
          disabled={pending || !canSave}
          aria-label={t("saveLabel", { model: model.displayName })}
          onClick={() => void save()}
        >
          {t("save")}
        </Button>
        <Button disabled={pending} onClick={onCancel}>
          {t("cancel")}
        </Button>
      </Stack>
    </Stack>
  );
}
