"use client";

import {
  Button,
  type Column,
  DataTable,
  Field,
  FormSection,
  Input,
  ListPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../components/form-error";
import { usePurposeDrafts } from "../../../../components/PurposeEditor";
import { usePagePath } from "../../../../components/shell/path";
import {
  type AdminModelInfo,
  type AdminModels,
  type AdminProvider,
  EVAL_PURPOSE,
  encodeModel,
  findPrice,
  type ModelPrice,
  type PriceTable,
  type PurposeView,
  parsePrice,
  putAdminPurpose,
  putModelPrice,
} from "../../../../lib/models";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { useServerState } from "../../../../lib/use-server-state";

export interface AdminModelsData extends AdminModels {
  purposes: PurposeView[];
}

/**
 * `/admin/models`：模型（企业管理员，ListPage，no inner nav：the sidebar's admin context navigates）。
 * - 供应商与模型：每个供应商一张表（能力、上下文长度、每百万 token 的价格，行内编辑 / 清除价格）；
 *   列模型失败的供应商只显示错误，不影响其他供应商；
 * - 用途默认映射：每个用途一张卡片（部署默认，各组织可在 `/settings/models` 覆盖）；插件声明的用途旁注
 *   「插件调用模型尚未开放」；`eval` 未映射时提示评测不能开评委。
 */
export default function AdminModelsView({ initial }: { initial: AdminModelsData }) {
  const scope = usePagePath("admin");
  const t = useTranslations("models");
  const [data, set] = useServerState(initial);
  const okProviders = data.providers.filter((p) => p.status === "ok");
  const evalView = data.purposes.find((p) => p.purpose === EVAL_PURPOSE);
  const setPrices = (next: PriceTable) => set({ ...data, ...next });
  // A functional update: the ActionRow saves several purposes at once
  const replacePurpose = (v: PurposeView) =>
    set((d) => ({ ...d, purposes: d.purposes.map((p) => (p.purpose === v.purpose ? v : p)) }));
  const { editor, actionRow } = usePurposeDrafts({
    purposes: data.purposes,
    providers: okProviders,
    scope: "deployment",
    save: (purpose, target) => putAdminPurpose(purpose, target).then((r) => r.purpose),
    onSaved: replacePurpose,
  });
  const body = (
    <>
      <FormSection
        id="providers"
        title={t("admin.providers.title")}
        description={t("admin.providers.description", { currency: data.currency })}
      >
        {data.providers.length === 0 ? (
          <Text tone="muted">{t("admin.noProviders")}</Text>
        ) : (
          data.providers.map((p) => (
            <ProviderModels key={p.provider} provider={p} data={data} onPrices={setPrices} />
          ))
        )}
      </FormSection>
      <FormSection
        id="purposes"
        title={t("admin.purposes.title")}
        description={t("admin.purposes.description")}
      >
        {evalView !== undefined && evalView.default === null ? (
          <Text tone="warn">{t("evalUnmapped")}</Text>
        ) : null}
        {data.purposes.map(editor)}
      </FormSection>
    </>
  );

  return (
    <ListPage
      header={{ path: [...scope, { label: "models" }], title: t("admin.title") }}
      {...(actionRow !== undefined ? { actionRow } : {})}
    >
      {body}
    </ListPage>
  );
}

/** 一个供应商：标题 + 模型表（或列模型失败的错误）。 */
function ProviderModels({
  provider: p,
  data,
  onPrices,
}: {
  provider: AdminProvider;
  data: AdminModels;
  onPrices(next: PriceTable): void;
}) {
  const t = useTranslations("models");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [editing, setEditing] = useState<string>();
  const grouped = new Intl.NumberFormat(locale);
  const num = (n: number) => grouped.format(n);
  const priceOf = (m: AdminModelInfo) => findPrice(data.prices, p.provider, m.id);
  const keyOf = (m: AdminModelInfo) => encodeModel({ provider: p.provider, model: m.id });

  async function clear(m: AdminModelInfo) {
    try {
      onPrices(await putModelPrice({ provider: p.provider, model: m.id, price: null }));
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

  return (
    <Stack gap={8}>
      <Stack direction="row" gap={8} align="center">
        <Text variant="h2" as="h3">
          {p.provider}
        </Text>
        {p.plugin !== p.provider ? (
          <Text variant="small" tone="muted">
            {p.plugin}
          </Text>
        ) : null}
      </Stack>
      {p.status === "error" ? (
        <FormError
          message={t("admin.providerError", { provider: p.provider })}
          extra={p.error === undefined ? [] : [p.error]}
        />
      ) : (
        <DataTable
          label={p.provider}
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
                onSaved={(next) => {
                  setEditing(undefined);
                  onPrices(next);
                }}
              />
            ) : null
          }
        />
      )}
    </Stack>
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
  onSaved(next: PriceTable): void;
}) {
  const t = useTranslations("models.admin.price");
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
      const next = await putModelPrice({
        provider,
        model: model.id,
        inputPerMTok: input,
        outputPerMTok: output,
        cacheReadPerMTok: cache(parsed.cacheRead),
        cacheWritePerMTok: cache(parsed.cacheWrite),
      });
      toast.success(t("saved", { model: model.displayName }));
      onSaved(next);
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
