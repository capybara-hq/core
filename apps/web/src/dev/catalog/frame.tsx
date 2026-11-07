import { AppShell, ContentSection, Grid, Stack, Text } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { COMMANDS } from "./fixtures";
import { sidebarProps, statusFixture } from "./shell-fixture";

/**
 * The catalog page's frame: a title over its sections on the page ground (only the design
 * system's layout primitives, no styles). No card around it: a demo of a box must stand on the
 * ground, never inside another box (spec §1 "One box is enough").
 */
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
    <Stack gap={24}>
      <Stack gap={4}>
        <Text variant="h1">{title}</Text>
        <Text variant="small" tone="muted">
          {subtitle}
        </Text>
      </Stack>
      {children}
    </Stack>
  );
}

/** A section: `§ title`, its note as the help line, the demos on the page ground. */
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
    <ContentSection title={`§ ${title}`} {...(note ? { description: note } : {})}>
      <Stack gap={16}>{children}</Stack>
    </ContentSection>
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
  agents: "list",
  inbox: "inbox",
  skills: "list",
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
