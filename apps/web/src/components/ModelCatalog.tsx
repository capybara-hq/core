"use client";

import {
  Button,
  CellTitle,
  type Column,
  DataTable,
  DateTime,
  EmptyState,
  Grid,
  Icon,
  Input,
  type MenuItem,
  Select,
  SkeletonText,
  Stack,
  Subsection,
  Switch,
  Text,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import type { ModelKind } from "../lib/agents";
import { labelLocale } from "../lib/extension-label";
import { type AdminModelInfo, kindOf, MODEL_KINDS, type ModelDisableChange } from "../lib/models";

/** Rows per page of a kind's table: a provider can list hundreds of models. */
export const CATALOG_PAGE_SIZE = 50;

/** The text of a model's description in the page locale (a plain string is the same in both). */
function describe(d: AdminModelInfo["description"], lang: "zh" | "en"): string | undefined {
  if (d === undefined) return undefined;
  return typeof d === "string" ? d : d[lang] || d.en;
}

/** What a page adds to one kind's table: its columns (before the switch), a row menu, an expand. */
export interface KindExtras<M> {
  columns?: Column<M>[];
  rowMenu?: (m: M) => MenuItem[];
  expand?: (m: M) => ReactNode | null;
}

const CAPS = ["tools", "vision", "documents", "reasoning", "caching"] as const;

/**
 * The columns the model info carries for a kind (between the model and the page's own): a chat
 * model's capabilities and context window, an embedding model's dimensions and input limit; the
 * other kinds carry nothing more than the model's name, publisher and description.
 */
function useKindColumns<M extends AdminModelInfo>(): (kind: ModelKind) => Column<M>[] {
  const t = useTranslations("models");
  const grouped = new Intl.NumberFormat(useLocale());
  const num = (n: number) => grouped.format(n);
  return (kind) => {
    if (kind === "chat") {
      return [
        {
          key: "capabilities",
          header: t("admin.columns.capabilities"),
          tone: "muted",
          // Plain text, not badges (「工具 · 缓存」), and never cut: it wraps instead of an ellipsis,
          // two or three to a line (a narrower column stacks them one per line)
          wrap: true,
          width: 160,
          // A list: DataTable joins it with 「 · 」 and breaks lines only between items
          cell: (m) =>
            CAPS.filter((c) => m.capabilities[c] === true).map((c) => t(`capability.${c}`)),
        },
        {
          key: "context",
          header: t("admin.columns.context"),
          align: "right",
          cell: (m) => (typeof m.contextWindow === "number" ? num(m.contextWindow) : "—"),
        },
      ];
    }
    if (kind === "embedding") {
      return [
        {
          key: "dimensions",
          header: t("admin.columns.dimensions"),
          wrap: true,
          cell: (m) => (m.embedding === undefined ? "—" : m.embedding.dimensions.map(num)),
        },
        {
          key: "maxInput",
          header: t("admin.columns.maxInput"),
          align: "right",
          cell: (m) => (m.embedding === undefined ? "—" : num(m.embedding.maxInputTokens)),
        },
      ];
    }
    return [];
  };
}

/**
 * One provider's models, the detail of the models tab (spec B §5.3, §5.6): the provider's name as
 * an h3 over its id and state line, the search (and, when the models have several publishers, the
 * publisher filter), then one divided Subsection per kind the provider has, in {@link MODEL_KINDS}
 * order, each holding the kind's table with its count and 「全部关闭」 / 「全部开启」 (for the
 * kind's rows on screen) in the heading row and a switch per model. The switches change the
 * provider's disabled list: `onChange` gets only the ids whose state changes (`disable` /
 * `enable`); ids the page does not show keep their stored state. Used by `/settings/models` (the
 * org's list) and `/admin/models` (the platform's, with price columns through `extras`).
 */
export function ModelCatalog<M extends AdminModelInfo>({
  provider,
  title,
  description,
  models,
  canSwitch = true,
  unlisted,
  pending = false,
  onChange,
  extras,
}: {
  /** The provider's name for the tables' accessible names. */
  provider: string;
  title: string;
  /** Under the title: the provider's id, its configuration state. */
  description?: ReactNode;
  models: M[];
  canSwitch?: boolean;
  /** The provider has no list here (its error, a note): shown in place of the models. */
  unlisted?: ReactNode;
  /** A change is being saved: the switches wait. */
  pending?: boolean;
  onChange(change: ModelDisableChange): void;
  /** A kind's own columns, row menu and expand (the platform's prices). */
  extras?: (kind: ModelKind) => KindExtras<M>;
}) {
  const t = useTranslations("models.catalog");
  const tk = useTranslations("models.kind");
  const tm = useTranslations("models");
  const lang = labelLocale(useLocale());
  const kindColumns = useKindColumns<M>();
  const [search, setSearch] = useState("");
  const [publisher, setPublisher] = useState("");
  const [pages, setPages] = useState<Record<string, number>>({});

  const publishers = useMemo(
    () => [...new Set(models.flatMap((m) => (m.publisher ? [m.publisher] : [])))].sort(),
    [models],
  );
  const q = search.trim().toLowerCase();
  const matchesSearch = (m: M) =>
    q === "" ||
    m.displayName.toLowerCase().includes(q) ||
    m.id.toLowerCase().includes(q) ||
    (m.publisher ?? "").toLowerCase().includes(q);
  const inPublisher = (m: M) => publisher === "" || m.publisher === publisher;

  const groups = MODEL_KINDS.map((kind) => ({
    kind,
    all: models.filter((m) => kindOf(m) === kind),
  })).filter((g) => g.all.length > 0);
  const shown = groups
    .map((g) => ({ ...g, rows: g.all.filter((m) => matchesSearch(m) && inPublisher(m)) }))
    .filter((g) => g.rows.length > 0);

  // Only the rows on screen whose state changes are sent
  const bulk = (kind: ModelKind, off: boolean) => {
    const ids = models
      .filter(
        (m) =>
          kindOf(m) === kind && inPublisher(m) && matchesSearch(m) && (m.disabled === true) !== off,
      )
      .map((m) => m.id);
    onChange(off ? { disable: ids, enable: [] } : { disable: [], enable: ids });
  };
  const toggle = (m: M, on: boolean) =>
    onChange(on ? { disable: [], enable: [m.id] } : { disable: [m.id], enable: [] });

  const modelColumn: Column<M> = {
    key: "model",
    header: tm("admin.columns.model"),
    // A minimum for the names (「deepseek/deepseek-chat」 is not cut to 「deepseek/dee」)
    width: 240,
    cell: (m) => {
      const text = describe(m.description, lang);
      return (
        <Stack gap={0}>
          <Text>{m.displayName}</Text>
          {m.displayName !== m.id ? (
            <Text variant="small" tone="muted">
              {m.id}
            </Text>
          ) : null}
          {text !== undefined ? (
            <Text variant="small" tone="muted">
              {text}
            </Text>
          ) : null}
          {m.retiresAt !== undefined ? (
            <Stack direction="row" gap={4} align="center">
              <Text variant="small" tone="warn" icon="circle-alert">
                {t("retiring")}
              </Text>
              <DateTime value={m.retiresAt} form="compact" />
            </Stack>
          ) : null}
        </Stack>
      );
    },
  };
  const publisherColumn: Column<M> = {
    key: "publisher",
    header: t("publisher"),
    tone: "muted",
    cell: (m) => m.publisher ?? "—",
  };
  const switchColumn: Column<M> = {
    key: "enabled",
    header: t("enabled"),
    width: 72,
    align: "right",
    interactive: true,
    cell: (m) => (
      <Switch
        label={m.displayName}
        checked={m.disabled !== true}
        disabled={!canSwitch || pending}
        onChange={(on) => toggle(m, on)}
      />
    ),
  };

  const filters =
    models.length > 0 ? (
      <Stack direction="row" gap={8} align="center" wrap>
        <Input
          aria-label={t("search")}
          placeholder={t("search")}
          prefix={<Icon name="search" size={14} />}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPages({});
          }}
        />
        {publishers.length > 1 ? (
          <Select
            aria-label={t("publisher")}
            value={publisher}
            onChange={(e) => {
              setPublisher(e.target.value);
              setPages({});
            }}
            options={[
              { value: "", label: t("allPublishers") },
              ...publishers.map((p) => ({ value: p, label: p })),
            ]}
          />
        ) : null}
      </Stack>
    ) : null;

  const body =
    unlisted !== undefined ? (
      unlisted
    ) : models.length === 0 ? (
      <EmptyState size="compact" text={t("none")} />
    ) : shown.length === 0 ? (
      <EmptyState size="compact" text={t("noMatch")} />
    ) : (
      shown.map((g) => {
        const kindLabel = tk(g.kind);
        const extra = extras?.(g.kind) ?? {};
        const anyOn = g.rows.some((m) => m.disabled !== true);
        const anyOff = g.rows.some((m) => m.disabled === true);
        const page = pages[g.kind] ?? 1;
        const rows =
          g.rows.length > CATALOG_PAGE_SIZE
            ? g.rows.slice((page - 1) * CATALOG_PAGE_SIZE, page * CATALOG_PAGE_SIZE)
            : g.rows;
        return (
          <Subsection
            key={g.kind}
            variant="divided"
            title={kindLabel}
            count={g.rows.length}
            {...(canSwitch
              ? {
                  actions: (
                    <>
                      <Button
                        density="dense"
                        variant="ghost"
                        disabled={pending || !anyOn}
                        onClick={() => bulk(g.kind, true)}
                      >
                        {t("turnAllOff")}
                      </Button>
                      <Button
                        density="dense"
                        variant="ghost"
                        disabled={pending || !anyOff}
                        onClick={() => bulk(g.kind, false)}
                      >
                        {t("turnAllOn")}
                      </Button>
                    </>
                  ),
                }
              : {})}
          >
            <DataTable<M>
              label={shown.length === 1 ? provider : `${provider} · ${kindLabel}`}
              columns={[
                modelColumn,
                ...(publishers.length > 1 ? [publisherColumn] : []),
                ...kindColumns(g.kind),
                ...(extra.columns ?? []),
                switchColumn,
              ]}
              rows={rows}
              rowKey={(m) => m.id}
              {...(extra.rowMenu !== undefined ? { rowMenu: extra.rowMenu } : {})}
              {...(extra.expand !== undefined ? { expand: extra.expand } : {})}
              {...(g.rows.length > CATALOG_PAGE_SIZE
                ? {
                    pagination: {
                      page,
                      pageSize: CATALOG_PAGE_SIZE,
                      total: g.rows.length,
                      onPage: (p: number) => setPages((x) => ({ ...x, [g.kind]: p })),
                    },
                  }
                : {})}
            />
          </Subsection>
        );
      })
    );

  return (
    <Stack gap={16}>
      <Stack gap={4}>
        <Text variant="h3">{title}</Text>
        {description}
      </Stack>
      {unlisted === undefined ? filters : null}
      {body}
    </Stack>
  );
}

/** One row of the providers list: the provider's name, its id, its model count or its failure. */
export interface ProviderRow {
  /** The provider's plugin: the row's key and the `?provider=` value. */
  plugin: string;
  name: string;
  /** Muted under the name when it is not the name. */
  id?: string;
  /** The models it lists; absent when it has no list here. */
  count?: number;
  /** Listing its models failed. */
  failed?: boolean;
}

/**
 * The models tab of the models pages: the providers beside the open one's models
 * (`Grid columns="list-detail" divided`, stacked below 640). On the left one row per provider
 * (its display name over its plugin id, its model count, or 「失败」 when its list failed); the
 * open one is the URL's `?provider=`, the first by default. On the right `children`: the open
 * provider's {@link ModelCatalog}.
 */
export function ModelProviders({
  providers,
  selected,
  onSelect,
  children,
}: {
  providers: ProviderRow[];
  selected: string | undefined;
  onSelect(plugin: string): void;
  children: ReactNode;
}) {
  const t = useTranslations("models.providers");
  const columns: Column<ProviderRow>[] = [
    {
      key: "provider",
      header: t("provider"),
      cell: (p) => (
        <CellTitle
          title={p.name}
          mono
          {...(p.id !== undefined && p.id !== p.name ? { description: p.id } : {})}
        />
      ),
    },
    {
      key: "count",
      header: t("count"),
      align: "right",
      cell: (p) =>
        p.failed ? (
          <Text variant="small" tone="fail" icon="circle-x">
            {t("failed")}
          </Text>
        ) : (
          (p.count ?? "—")
        ),
    },
  ];
  return (
    <Grid columns="list-detail" divided>
      <DataTable<ProviderRow>
        label={t("label")}
        rowHeight="roomy"
        columns={columns}
        rows={providers}
        rowKey={(p) => p.plugin}
        rowLabel={(p) => p.name}
        {...(selected !== undefined ? { activeKey: selected } : {})}
        onOpen={(p) => onSelect(p.plugin)}
      />
      {children}
    </Grid>
  );
}

/**
 * The models tab while its read is on the way: the same grid, the providers table loading on the
 * left and, on the right, the name's slot over a loading chat table with the loaded table's
 * header (`columns`, the page's chat columns).
 */
export function ModelProvidersLoading({ columns }: { columns: { key: string; header: string }[] }) {
  const t = useTranslations("models");
  return (
    <Grid columns="list-detail" divided>
      <DataTable<ProviderRow>
        label={t("providers.label")}
        rowHeight="roomy"
        columns={(["provider", "count"] as const).map((key) => ({
          key,
          header: t(`providers.${key}`),
          cell: () => null,
        }))}
        rows={[]}
        rowKey={(p) => p.plugin}
        state="loading"
      />
      <Stack gap={16}>
        <SkeletonText width={160} />
        <DataTable<AdminModelInfo>
          label={t("kind.chat")}
          columns={columns.map((c) => ({ ...c, cell: () => null }))}
          rows={[]}
          rowKey={(m) => m.id}
          state="loading"
        />
      </Stack>
    </Grid>
  );
}
