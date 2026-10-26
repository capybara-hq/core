import { AppShell, Card, Grid, Stack, Text } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { COMMANDS } from "./fixtures";
import { sidebarProps, statusFixture } from "./shell-fixture";

/** 目录页外框：一张大卡片承载各分区（只用设计系统的布局原语，不写样式）。 */
export function CatalogPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
}) {
  return (
    <Card
      title={
        <Stack gap={4}>
          <Text variant="h1">{title}</Text>
          <Text variant="small" tone="muted">
            {subtitle}
          </Text>
        </Stack>
      }
    >
      <Stack gap={24}>{children}</Stack>
    </Card>
  );
}

/** 一个分区：`§ 标题 — 说明`。 */
export function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <Card title={note ? `§ ${title} — ${note}` : `§ ${title}`}>
      <Stack gap={16}>{children}</Stack>
    </Card>
  );
}

/** 左侧状态标注（muted）+ 右侧样例，标注不属于组件本身。 */
export function Row({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <Grid columns="form" gap={12}>
      <Text variant="small" tone="muted">
        {label}
      </Text>
      <Stack direction="row" gap={12} align="center" wrap>
        {children}
      </Stack>
    </Grid>
  );
}

/** Where the catalog's sidebar links go: the template that stands for each item. */
const TEMPLATE_OF: Record<string, string> = {
  overview: "overview",
  agents: "list",
  inbox: "inbox",
  connectors: "list",
  evals: "trace",
  settings: "settings",
  new: "list",
};
const catalogHref = (id: string) => `/dev/ui/templates/${TEMPLATE_OF[id] ?? "detail"}`;

/**
 * The App Shell of the template routes (not the auth page): the fixture sidebar with `nav` current,
 * the drawer bar titled `title`, and the status bar at `/<context>`.
 */
export function FixtureShell({
  nav,
  context,
  title,
  children,
}: {
  nav: string;
  context: string;
  title?: string;
  children?: ReactNode;
}) {
  const { onOpenCommands: _, ...sidebar } = sidebarProps({ active: nav }, catalogHref);
  return (
    <AppShell
      sidebar={sidebar}
      commands={COMMANDS}
      status={statusFixture(`/${context}`)}
      {...(title ? { title } : {})}
    >
      {children}
    </AppShell>
  );
}
