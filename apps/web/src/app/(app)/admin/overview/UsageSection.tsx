"use client";

import {
  type Column,
  DataTable,
  formatCompact,
  OverviewSection,
  Stack,
  Subsection,
  Text,
  TextLink,
  TrendChart,
  useTimeZone,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import type { AdminUsageDay, AdminUsageOrg, AdminUsageWeek } from "../../../../lib/admin";
import { adminUsageQuery } from "../../../../lib/query/admin";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useErrorMessage } from "../../../../lib/use-error-message";

type T = ReturnType<typeof useTranslations<"admin.overview.usage">>;

/** Counts as the overview formats them (grouped digits in both locales, spec §8.2). */
const count = (n: number) => n.toLocaleString("en-US");

/** The process's zone: what a render without a known zone (no server clock) counts days in. */
const processZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The reader's zone the usage week is read in (spec §8.3): the server's in the server render and
 * the hydration, the browser's afterwards. The key holds it, so the header and the section share
 * one read.
 */
export function useUsageZone(): string {
  return useTimeZone() ?? processZone();
}

/** The overview's 用量 read in the reader's zone (the section and the header's 近 7 天运行). */
export function useAdminUsage() {
  const q = adminUsageQuery(useUsageZone());
  return useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
}

/** A day's tokens: the five kinds summed (the chart's one Token measure, spec §6.3). */
const dayTokens = (d: AdminUsageDay) =>
  d.tokens.input + d.tokens.output + d.tokens.cacheRead + d.tokens.cacheWrite + d.tokens.embedding;

/** The week's runs (the header's 近 7 天运行). */
export const weekRuns = (week: AdminUsageWeek) => week.days.reduce((n, d) => n + d.runs, 0);

/**
 * The week's estimated cost: the priced days summed; null when no day had a priced token but some
 * day used tokens (never shown as 0).
 */
function weekCost(week: AdminUsageWeek): number | null {
  const priced = week.days.filter((d) => d.cost !== null);
  if (priced.length === 0) return null;
  return priced.reduce((n, d) => n + (d.cost ?? 0), 0);
}

/** An amount in the answer's currency with 2 decimals (an unknown code: the code and the number). */
function moneyFormat(locale: string, currency: string): (n: number) => string {
  try {
    const f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return (n) => f.format(n);
  } catch {
    return (n) => `${currency} ${n.toFixed(2)}`;
  }
}

/** One row of the ranking: an org, or the sum of the orgs outside the top 10. */
type RankRow =
  | (AdminUsageOrg & { kind: "org" })
  | (AdminUsageWeek["otherOrgs"] & { kind: "others" });

/**
 * 用量 · 近 7 天 (spec §6.3): a `TrendChart` with two panels sharing the dates, 运行 and Token (the
 * five kinds summed), today the current point and the estimated cost in each day's tooltip and
 * in the chart's table (估算 ¥12.30, or 未定价 when the day used tokens and none were priced: never
 * 0); under it the 7-day total (with a note linking `/admin/models` when some models have no
 * price) and 组织排行, the top 10 orgs by tokens and a 其他 row. Totals only (spec §9). Read in the
 * reader's zone, not prefetched: its own skeleton on the first paint, its own error and 重试.
 */
export function UsageSection() {
  const t = useTranslations("admin.overview.usage");
  const errorMessage = useErrorMessage();
  const read = useAdminUsage();
  const columns = rankColumns(t, null);
  const title = t("title");
  const actions = <Text tone="muted">{t("estimated")}</Text>;
  if (read.data === undefined) {
    return read.error ? (
      <OverviewSection
        title={title}
        actions={actions}
        state="error"
        error={{
          summary: t("failed"),
          detail: errorMessage(read.error),
          onRetry: () => void read.refetch(),
        }}
      />
    ) : (
      <OverviewSection
        title={title}
        actions={actions}
        state="loading"
        loading={[
          { kind: "lines", lines: 4 },
          { kind: "table", label: t("ranking.title"), columns },
        ]}
      />
    );
  }
  return (
    <OverviewSection title={title} actions={actions} state="ready">
      <UsageWeek week={read.data} t={t} />
    </OverviewSection>
  );
}

function UsageWeek({ week, t }: { week: AdminUsageWeek; t: T }) {
  const locale = useLocale();
  const money = moneyFormat(locale, week.currency);
  const compact = (n: number) => formatCompact(n, locale);
  const costText = (cost: number | null) => (cost === null ? t("unpriced") : money(cost));
  const columns = rankColumns(t, { compact, costText });
  const days = week.days;
  const tokens = days.map(dayTokens);
  const total = t("total", {
    runs: count(weekRuns(week)),
    tokens: compact(tokens.reduce((n, v) => n + v, 0)),
    cost: costText(weekCost(week)),
  });
  const rows: RankRow[] = [
    ...week.orgs.map((o) => ({ ...o, kind: "org" as const })),
    ...(week.otherOrgs.count > 0 ? [{ ...week.otherOrgs, kind: "others" as const }] : []),
  ];
  return (
    <Stack gap={16}>
      <Stack gap={8}>
        <TrendChart
          label={t("chart")}
          x={days.map((d) => ({ key: d.date, label: d.date.slice(5) }))}
          panels={[
            { id: "runs", label: t("runs"), values: days.map((d) => d.runs), format: count },
            { id: "tokens", label: t("tokens"), values: tokens, format: compact },
          ]}
          current={days.length - 1}
          extra={(i) => {
            const cost = days[i]?.cost ?? null;
            return cost === null ? t("unpriced") : t("estimate", { cost: money(cost) });
          }}
          extraLabel={t("cost")}
          empty={t("empty")}
        />
        <Text variant="prose" tone="muted">
          {total}
          {week.costPartial ? <TextLink href="/admin/models">{t("costPartial")}</TextLink> : null}
        </Text>
      </Stack>
      {rows.length > 0 ? (
        <Subsection title={t("ranking.title")} variant="divided">
          <DataTable<RankRow>
            label={t("ranking.title")}
            rowHeight="dense"
            framed={false}
            columns={columns}
            rows={rows}
            rowKey={(r) => (r.kind === "org" ? r.orgId : "others")}
            state="ready"
          />
        </Subsection>
      ) : null}
    </Stack>
  );
}

/** The ranking's columns; `fmt` null draws the headers only (the skeleton). */
function rankColumns(
  t: T,
  fmt: { compact(n: number): string; costText(cost: number | null): string } | null,
): Column<RankRow>[] {
  return [
    {
      key: "org",
      header: t("ranking.org"),
      cell: (r) =>
        r.kind === "org" ? (
          <TextLink href="/admin/orgs">{r.name}</TextLink>
        ) : (
          <Text variant="prose" tone="muted">
            {t("ranking.others", { n: r.count })}
          </Text>
        ),
    },
    {
      key: "runs",
      header: t("ranking.runs"),
      align: "right",
      fit: true,
      cell: (r) => count(r.runs),
    },
    {
      key: "tokens",
      header: t("ranking.tokens"),
      align: "right",
      fit: true,
      cell: (r) => fmt?.compact(r.tokens) ?? "",
    },
    {
      key: "cost",
      header: t("ranking.cost"),
      align: "right",
      fit: true,
      cell: (r) =>
        r.cost === null ? <Text tone="muted">{fmt?.costText(null)}</Text> : fmt?.costText(r.cost),
    },
  ];
}
