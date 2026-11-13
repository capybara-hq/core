"use client";

import {
  Button,
  type Column,
  ErrorDetail,
  Field,
  FormSection,
  Input,
  ListPage,
  type PageHeaderProps,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import {
  type KindExtras,
  ModelCatalog,
  ModelProviders,
  ModelProvidersLoading,
} from "../../../../components/ModelCatalog";
import { useModelDisabling } from "../../../../components/ModelDisabling";
import { NoAccess } from "../../../../components/NoAccess";
import { usePurposeDrafts } from "../../../../components/PurposeEditor";
import { usePagePath } from "../../../../components/shell/path";
import type { ModelKind } from "../../../../lib/agents";
import { extensionLabel, labelLocale } from "../../../../lib/extension-label";
import {
  type AdminModelInfo,
  type AdminModels,
  type AdminProvider,
  encodeModel,
  findPrice,
  type ModelDisableChange,
  type ModelPrice,
  type ModelsTab,
  type PurposeTarget,
  type PurposeView,
  parseModelsTab,
  parsePrice,
  putAdminPurpose,
  putModelPrice,
  selectedProvider,
} from "../../../../lib/models";
import { adminModelsQuery, adminPurposesQuery } from "../../../../lib/query/admin";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useAdmin } from "../../../../lib/query/workspace";
import type { Me } from "../../../../lib/session";
import { useUrlParam, useUrlTab } from "../../../../lib/url-tab";
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
    invalidates: () => [keys.deployment().platformAuditAll()],
    onSuccess: (r) =>
      qc.setQueryData<AdminModels>(adminModelsQuery().queryKey, (d) =>
        d === undefined ? d : { ...d, ...r },
      ),
  });
}

/**
 * The purposes while they load, as PurposeEditor draws them at the deployment scope: the kernel's
 * seven (eval, title, command review, web extraction and the three sub-agent tiers), each a row
 * with its one hint (what happens while it is unset) over the model select.
 */
const LOADING_PURPOSES = [1, 1, 1, 1, 1, 1, 1].map((lines) => ({
  lines,
  lineSize: "small" as const,
  field: { control: "select" as const },
}));

/** The chat table's columns on this page (the loading table draws the same header). */
const CHAT_COLUMNS = [
  "model",
  "capabilities",
  "context",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
] as const;

/**
 * `/admin/models`：模型（超级管理员，ListPage，no inner nav：the sidebar's admin context navigates），
 * two tabs in the head, kept in the address:
 * - 模型 (the bare page): the providers beside the open one's models (`?provider=<plugin>`, the
 *   first by default), one table per kind with the kind's columns (a chat model's capabilities,
 *   context and per-million-token prices, edited or cleared from the row menu; an embedding
 *   model's dimensions and input price); a provider that failed to list its models shows its error
 *   in the detail, never affecting the others;
 * - 用途默认 (`?tab=purposes`): one row per purpose (the deployment default, which each org may
 *   override in `/settings/models`), saved by the page's ActionRow.
 * From the query cache (the layout prefetched both reads on a first load, for either tab); a saved
 * price or purpose is written into the cache.
 */
export default function AdminModelsView({
  tab = "models",
  provider = "",
}: {
  tab?: ModelsTab;
  provider?: string;
}) {
  const gate = useAdmin();
  if (gate.kind === "pending") return null;
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminModelsRead me={gate.me} initialTab={tab} initialProvider={provider} />;
}

function AdminModelsRead({
  me,
  initialTab,
  initialProvider,
}: {
  me: Me;
  initialTab: ModelsTab;
  initialProvider: string;
}) {
  const scope = usePagePath("admin");
  const t = useTranslations("models");
  const tc = useTranslations("models.admin.columns");
  const models = usePageQuery(adminModelsQuery());
  const purposes = usePageQuery(adminPurposesQuery());
  const [tab, setTab] = useUrlTab(initialTab, parseModelsTab, "models");
  const [provider, setProvider] = useUrlParam("provider", initialProvider, (r) => r ?? "", "");
  const header = {
    path: [...scope, { label: "models" }],
    title: t("admin.title"),
    tabs: (["models", "purposes"] as const).map((id) => ({
      id,
      label: t(`tabs.${id}`),
      onSelect: () => setTab(id),
    })),
    activeTab: tab,
  };
  if (models.kind === "notFound" || purposes.kind === "notFound") return <NotFound />;
  if (models.kind === "error") return <ErrorFrame reset={models.retry} />;
  if (purposes.kind === "error") return <ErrorFrame reset={purposes.retry} />;
  if (models.kind === "loading" || purposes.kind === "loading") {
    // The open tab's frame: the providers grid (its names come with the data) or the kernel's
    // purposes as rows.
    return (
      <ListPage header={header} loading={{ keep: true }}>
        {tab === "models" ? (
          <ModelProvidersLoading
            columns={[
              ...CHAT_COLUMNS.map((key) => ({ key, header: tc(key) })),
              { key: "enabled", header: t("catalog.enabled") },
            ]}
          />
        ) : (
          <FormSection
            id="purposes"
            layout="stacked"
            title={t("admin.purposes.title")}
            description={t("admin.purposes.description")}
            loading={{ items: LOADING_PURPOSES }}
          />
        )}
      </ListPage>
    );
  }
  return (
    <ModelsBody
      header={header}
      tab={tab}
      provider={provider}
      onProvider={setProvider}
      data={{ ...models.data, purposes: purposes.data.purposes }}
      orgId={me.currentOrgId}
    />
  );
}

function ModelsBody({
  header,
  tab,
  provider,
  onProvider,
  data,
  orgId,
}: {
  header: PageHeaderProps;
  tab: ModelsTab;
  provider: string;
  onProvider(plugin: string): void;
  data: AdminModels & { purposes: PurposeView[] };
  orgId: string | null;
}) {
  const t = useTranslations("models");
  const locale = useLocale();
  const qc = useQueryClient();
  const okProviders = data.providers.filter((p) => p.status === "ok");
  // The platform's switches: a model off here is invisible to every org. The current org's lists
  // (models, catalog) change with it.
  const disabling = useModelDisabling({
    scope: "platform",
    purposes: data.purposes,
    // the overview (a provider without a usable chat model) and the audit log change too
    invalidates: () => [
      keys.deployment().adminModels(),
      keys.deployment().adminOverview(),
      keys.deployment().platformAuditAll(),
      ...(orgId === null ? [] : [keys.org(orgId).models(), keys.org(orgId).modelsCatalog()]),
    ],
  });
  // The answer is the saved purpose: it replaces that purpose in the cache (a functional update:
  // the ActionRow saves several purposes at once). The current org's purposes show the deployment
  // default, so they are read again.
  const put = useAppMutation({
    fn: (v: { purpose: string; target: PurposeTarget | null }) =>
      putAdminPurpose(v.purpose, v.target),
    invalidates: () => [
      keys.deployment().platformAuditAll(),
      ...(orgId === null ? [] : [keys.org(orgId).orgPurposes()]),
    ],
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

  if (tab === "purposes") {
    // The drafts live in this component: a switch to 模型 and back keeps them. The tab's one
    // section is stacked: its title and description above a card of the full content width.
    return (
      <ListPage header={header} {...(actionRow !== undefined ? { actionRow } : {})}>
        <FormSection
          id="purposes"
          layout="stacked"
          title={t("admin.purposes.title")}
          description={t("admin.purposes.description")}
          flush
        >
          {list(t("admin.purposes.title"))}
        </FormSection>
      </ListPage>
    );
  }

  const open = selectedProvider(data.providers, provider);
  const nameOf = (p: AdminProvider) =>
    extensionLabel({ name: p.provider, displayName: p.displayName }, labelLocale(locale));
  return (
    <ListPage
      header={header}
      {...(data.providers.length === 0
        ? {
            empty: {
              text: t("admin.noProviders"),
              action: {
                label: t("admin.toPlugins"),
                href: "/admin/plugins",
                variant: "primary" as const,
              },
            },
          }
        : {})}
    >
      {disabling.notice}
      {open === undefined ? null : (
        <Stack gap={16}>
          <Text variant="prose" tone="muted">
            {t("admin.providers.description", { currency: data.currency })}
          </Text>
          <ModelProviders
            providers={data.providers.map((p) => ({
              plugin: p.plugin,
              name: nameOf(p),
              icon: p.icon ?? null,
              id: p.displayName ? p.provider : p.plugin,
              ...(p.status === "ok" ? { count: p.models.length } : {}),
              failed: p.status === "error",
            }))}
            selected={open.plugin}
            onSelect={onProvider}
          >
            <ProviderModels
              key={open.plugin}
              provider={open}
              name={nameOf(open)}
              data={data}
              pending={disabling.pending}
              onDisable={disabling.change}
            />
          </ModelProviders>
        </Stack>
      )}
    </ListPage>
  );
}

/** The open provider: its name, id and state over its models' tables (or its listing error). */
function ProviderModels({
  provider: p,
  name: providerName,
  data,
  pending,
  onDisable,
}: {
  provider: AdminProvider;
  name: string;
  data: AdminModels;
  pending: boolean;
  onDisable(provider: string, change: ModelDisableChange): void;
}) {
  const t = useTranslations("models");
  const locale = useLocale();
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

  const priceColumn = (k: PriceField): Column<AdminModelInfo> => ({
    key: k,
    header: t(`admin.columns.${k}`),
    // Narrow: the mono figures fit, so the table fits the content width
    width: 80,
    align: "right",
    ...(k === "cacheRead" || k === "cacheWrite" ? { tone: "muted" as const } : {}),
    cell: (m) => {
      const pr = priceOf(m);
      if (pr === undefined) return "—";
      if (k === "input") return num(pr.inputPerMTok);
      if (k === "output") return num(pr.outputPerMTok);
      const v = k === "cacheRead" ? pr.cacheReadPerMTok : pr.cacheWritePerMTok;
      return v === null ? t("admin.sameAsInput") : num(v);
    },
  });

  // Prices are the billed kinds' (usage is recorded for chat and embedding calls only): a chat
  // model has the four, an embedding model only its input price.
  const extras = (kind: ModelKind): KindExtras<AdminModelInfo> => {
    const fields = PRICED[kind];
    if (fields === undefined) return {};
    return {
      columns: fields.map(priceColumn),
      rowMenu: (m) => [
        { label: t("admin.menu.editPrice"), onSelect: () => setEditing(keyOf(m)) },
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
      ],
      expand: (m) =>
        editing === keyOf(m) ? (
          <PriceEditor
            provider={p.provider}
            model={m}
            fields={fields}
            price={priceOf(m)}
            onCancel={() => setEditing(undefined)}
            onSaved={() => setEditing(undefined)}
          />
        ) : null,
    };
  };

  // The provider's id under its name when the name is not the id (plain metadata, mono muted);
  // a provider that failed to list its models shows its error in place of its tables; a provider
  // the orgs configure themselves says so (no list: the platform has no config of its own).
  const id = p.displayName ? p.provider : p.plugin !== p.provider ? p.plugin : undefined;
  const unlisted =
    p.status === "error" ? (
      <ErrorDetail
        summary={t("admin.providerError", { provider: providerName })}
        {...(p.error === undefined ? {} : { detail: p.error })}
      />
    ) : p.status === "org_configured" ? (
      <Text variant="prose" tone="muted">
        {t("catalog.orgsConfigure")}
      </Text>
    ) : p.status !== "ok" ? (
      <Text variant="prose" tone="muted">
        {t("catalog.none")}
      </Text>
    ) : undefined;

  return (
    <ModelCatalog<AdminModelInfo>
      provider={providerName}
      title={providerName}
      {...(id !== undefined
        ? {
            description: (
              <Text variant="small" tone="muted">
                {id}
              </Text>
            ),
          }
        : {})}
      models={p.status === "ok" ? p.models : []}
      {...(unlisted !== undefined ? { unlisted } : {})}
      pending={pending}
      onChange={(change) => onDisable(p.provider, change)}
      extras={extras}
    />
  );
}

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type PriceField = (typeof PRICE_FIELDS)[number];

/** The price fields of the billed kinds: a chat model's four, an embedding model's input. */
const PRICED: Partial<Record<ModelKind, readonly PriceField[]>> = {
  chat: PRICE_FIELDS,
  embedding: ["input"],
};

/**
 * 行内的价格编辑（`fields`：这一类模型的价格项）：输入 / 输出必填，缓存读 / 写留空按输入价计；单价
 * 0..1e6。An embedding model edits only its input price: its output price stays what it was (0 when
 * new) and its cache prices follow the input.
 */
function PriceEditor({
  provider,
  model,
  fields,
  price,
  onCancel,
  onSaved,
}: {
  provider: string;
  model: AdminModelInfo;
  fields: readonly PriceField[];
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
  const invalid = fields.some((f) => parsed[f] === "invalid");
  const input = parsed.input;
  const output = fields.includes("output") ? parsed.output : (price?.outputPerMTok ?? 0);
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
        cacheReadPerMTok: fields.includes("cacheRead") ? cache(parsed.cacheRead) : null,
        cacheWritePerMTok: fields.includes("cacheWrite") ? cache(parsed.cacheWrite) : null,
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
        {fields.map((f) => (
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
