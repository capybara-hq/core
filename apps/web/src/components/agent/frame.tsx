"use client";

import {
  type ActionRowProps,
  type FieldShape,
  type FormSectionLayout,
  type ItemShape,
  type PageHeaderProps,
  SettingsPage,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import type { Agent } from "../../lib/agents";
import { uiLocale } from "../../lib/ui";
import { useOfferedContributions } from "../extension-ui/ClientComponentBlock";
import { useSlotContributions } from "../extension-ui/ExtensionSlot";
import {
  type AgentSection,
  type AgentSectionId,
  builtinSection,
  extSectionId,
  READ_ONLY_FIELDS,
  SECTION_DESCRIPTIONS,
  SECTION_FIELDS,
  SECTION_LAYOUTS,
  type SectionShape,
  sectionHref,
  sectionsFor,
} from "./sections";

/** What every section of the agent page reads: the agent, who is looking, the open section. */
export interface AgentPageValue {
  orgId: string;
  agent: Agent;
  /** The viewer may change the agent (owner or org admin); else every section is read-only. */
  editable: boolean;
  section: AgentSectionId;
  header: PageHeaderProps;
  nav: { group: string; items: { id: string; label: string; href: string }[] }[];
  /** A section reports its unsaved edits, so leaving it asks first. */
  setDirty(dirty: boolean): void;
}

export const AgentPageContext = createContext<AgentPageValue | null>(null);

/** The agent page's context; only inside {@link AgentPage}. */
export function useAgentPage(): AgentPageValue {
  const v = useContext(AgentPageContext);
  if (v === null) throw new Error("useAgentPage outside AgentPage");
  return v;
}

/**
 * A section's loading frame: its field layout (or its item rows, in a flush card), title, the
 * description it knows and its layout.
 */
export function loadingSection(
  section: AgentSection,
  shape: SectionShape,
  t: (key: string) => string,
): ({ fields: FieldShape[] } | { items: ItemShape[] }) & {
  title: string;
  description?: string;
  layout?: FormSectionLayout;
} {
  const description = SECTION_DESCRIPTIONS[section];
  const layout = SECTION_LAYOUTS[section];
  return {
    ...(Array.isArray(shape) ? { fields: shape } : { items: shape.items }),
    title: t(`sections.${section}`),
    ...(description !== undefined ? { description: t(description) } : {}),
    ...(layout !== undefined ? { layout } : {}),
  };
}

/** The extensions' sections of the agent page (`agent.detail.section`), in the kernel's order. */
export function useExtSections(orgId: string) {
  return useSlotContributions(orgId, "agent.detail.section").items;
}

/**
 * The nav of the sections this viewer sees: the built-in ones, then one item per extension
 * section (its title), for editable and read-only viewers alike. A client component's section is
 * listed only while its code may run (not in safe mode, under the kill switch or after the crash
 * budget); its direct link shows the section's "not available" state.
 */
export function useSectionNav(orgId: string, agentId: string, editable: boolean) {
  const t = useTranslations("agents.page");
  const locale = uiLocale(useLocale());
  const ext = useOfferedContributions(useExtSections(orgId));
  return [
    {
      group: t("navGroup"),
      items: [
        ...sectionsFor(editable).map((s) => ({
          id: s as string,
          label: t(`sections.${s}`),
          href: sectionHref(agentId, s),
        })),
        ...ext.map((c) => ({
          id: extSectionId(c) as string,
          label: c.title[locale],
          href: sectionHref(agentId, extSectionId(c)),
        })),
      ],
    },
  ];
}

/**
 * One section of the agent page: the `SettingsPage` template with the page's head and section
 * nav, the section's content, and its own action row (Save, Discard) while it has changes.
 * `dirty` tells the page the section holds unsaved edits; `loading` draws the section's static
 * field layout while its reads are on the way, or, with `children`, those children (a section that
 * draws its own loading frame: the 渠道 cards on the page ground) inside the page's busy region.
 */
export function AgentSectionFrame({
  actionRow,
  dirty = false,
  loading = false,
  children,
}: {
  actionRow?: ActionRowProps | undefined;
  dirty?: boolean;
  loading?: boolean;
  children?: ReactNode;
}) {
  const page = useAgentPage();
  const t = useTranslations("agents.page");
  const { setDirty } = page;
  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);
  const built = builtinSection(page.section);
  const fields = page.editable
    ? SECTION_FIELDS[built]
    : (READ_ONLY_FIELDS[built] ?? SECTION_FIELDS[built]);
  return (
    <SettingsPage
      header={page.header}
      nav={page.nav}
      activeNav={page.section}
      {...(actionRow ? { actionRow } : {})}
      {...(loading
        ? {
            loading: children !== undefined ? {} : { sections: [loadingSection(built, fields, t)] },
          }
        : {})}
    >
      {children}
    </SettingsPage>
  );
}
