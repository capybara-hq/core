"use client";

import {
  Button,
  type Column,
  DataTable,
  DateTime,
  EmptyState,
  Icon,
  Input,
  type MenuItem,
  Select,
  Stack,
  Subsection,
  Switch,
  Text,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import type { ModelInfo, ModelKind } from "../lib/agents";
import { labelLocale } from "../lib/extension-label";
import { kindOf, MODEL_KINDS, type ModelDisableChange } from "../lib/models";

/** Rows per page of a kind's table: a provider can list hundreds of models. */
export const CATALOG_PAGE_SIZE = 50;

/** The text of a model's description in the page locale (a plain string is the same in both). */
function describe(d: ModelInfo["description"], lang: "zh" | "en"): string | undefined {
  if (d === undefined) return undefined;
  return typeof d === "string" ? d : d[lang] || d.en;
}

/**
 * One provider's models (spec B §5.3, §5.6): a flush Subsection whose head holds the search and,
 * when the models have several publishers, the publisher filter; below it one table per kind
 * (counts in each table's toolbar, 「全部关闭」 / 「全部开启」 for the kind's models of the chosen
 * publisher) with a switch per model. The switches change the provider's disabled list: `onChange`
 * gets only the ids whose state changes (`disable` / `enable`); ids the page does not show keep
 * their stored state. Used by
 * `/settings/models` (the org's list) and `/admin/models` (the platform's, with price columns).
 */
export function ModelCatalog<M extends ModelInfo>({
  provider,
  title,
  description,
  models,
  canSwitch = true,
  failed = false,
  pending = false,
  onChange,
  columns = [],
  rowMenu,
  expand,
}: {
  /** The provider's name for the tables' accessible names. */
  provider: string;
  title: string;
  /** Under the title: the provider's id, its configuration state. */
  description?: ReactNode;
  models: M[];
  canSwitch?: boolean;
  /** The provider could not list its models: the head only (its error is the description). */
  failed?: boolean;
  /** A change is being saved: the switches wait. */
  pending?: boolean;
  onChange(change: ModelDisableChange): void;
  /** Columns between the model and the switch (capabilities, prices). */
  columns?: Column<M>[];
  rowMenu?: (m: M) => MenuItem[];
  expand?: (m: M) => ReactNode | null;
}) {
  const t = useTranslations("models.catalog");
  const tk = useTranslations("models.kind");
  const tm = useTranslations("models");
  const lang = labelLocale(useLocale());
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
  const tableColumns = [
    modelColumn,
    ...(publishers.length > 1 ? [publisherColumn] : []),
    ...columns,
    switchColumn,
  ];

  const actions =
    models.length > 0 ? (
      <Stack direction="row" gap={8} align="center">
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
    ) : undefined;

  return (
    <Subsection
      variant="flush"
      title={title}
      count={models.length}
      {...(description !== undefined ? { description } : {})}
      {...(actions !== undefined ? { actions } : {})}
    >
      {failed ? null : models.length === 0 ? (
        <EmptyState size="compact" text={t("none")} />
      ) : shown.length === 0 ? (
        <EmptyState size="compact" text={t("noMatch")} />
      ) : (
        shown.map((g) => {
          const kindLabel = tk(g.kind);
          const scope = g.rows;
          const anyOn = scope.some((m) => m.disabled !== true);
          const anyOff = scope.some((m) => m.disabled === true);
          const page = pages[g.kind] ?? 1;
          const rows =
            g.rows.length > CATALOG_PAGE_SIZE
              ? g.rows.slice((page - 1) * CATALOG_PAGE_SIZE, page * CATALOG_PAGE_SIZE)
              : g.rows;
          return (
            <section key={g.kind} aria-label={kindLabel} data-kind={g.kind}>
              <DataTable<M>
                label={shown.length === 1 ? provider : `${provider} · ${kindLabel}`}
                columns={tableColumns}
                rows={rows}
                rowKey={(m) => m.id}
                {...(rowMenu !== undefined ? { rowMenu } : {})}
                {...(expand !== undefined ? { expand } : {})}
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
                toolbar={
                  <Stack direction="row" gap={8} align="center">
                    <Text variant="h3">{kindLabel}</Text>
                    <Text variant="small" tone="muted">
                      {g.rows.length}
                    </Text>
                    {canSwitch ? (
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
                    ) : null}
                  </Stack>
                }
              />
            </section>
          );
        })
      )}
    </Subsection>
  );
}
