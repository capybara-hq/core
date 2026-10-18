import { AppShell, Card, Grid, Stack, Text } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { shellStatus, topBar } from "./fixtures";

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

/** 模板路由的 App Shell：假顶栏 + 假状态栏（认证页不用）。 */
export function FixtureShell({
  nav,
  context,
  children,
}: {
  nav: string;
  context: string;
  children?: ReactNode;
}) {
  return (
    <AppShell topBar={topBar(nav)} status={shellStatus(context)}>
      {children}
    </AppShell>
  );
}
