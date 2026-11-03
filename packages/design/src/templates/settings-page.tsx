import { type ReactNode, useEffect, useRef } from "react";
import { SkeletonGroup } from "../display/skeleton";
import { Stack } from "../layout/index";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { LoadingFormSection } from "./form-page";
import {
  type CardShape,
  type FieldShape,
  LOADING_CARDS,
  LoadingShapedCards,
  loadingActionRow,
  loadingHeader,
  TemplateHead,
} from "./frame";

export type SettingsNavGroup = {
  group: string;
  items: { id: string; label: string; href: string; count?: number }[];
};

/**
 * T5 Settings (spec §5, canvas "组织 · 设置"): the head (path, title, actions) across the full
 * content width, then a 200 px sub-nav (mono group labels, 30 px items, the current one on
 * `sidebar-active`, mono counts) beside the section content; ActionRow on changes. The header's
 * `description` opens the content column instead of the head, so the head has one height and the
 * sub-nav sits at the same y on every settings page, its top aligned with the content's. Below
 * 640 the sub-nav is a compact control: one horizontally scrolling row of its items (no group
 * labels, 40 px tap targets) above the content, the current item scrolled into view.
 *
 * `loading` draws the page's frame while its data is on the way (spec §5.4): the header keeps its
 * rows, the sub-nav and the header's description stay real (they are static per page), an
 * ActionRow stays with its buttons disabled, and `sections` (one entry per section, its field
 * count, and the `title` / `description` the page already knows) are placeholders in the
 * sections' own frame in place of `children`; a section that lists cards takes `cards` instead of
 * `fields`. A page that is a stack of titled cards (no sections) passes `cards`: the cards'
 * `CardShape`s, or one `shape` repeated `count` times (default {@link LOADING_CARDS}, 3); they
 * stand in a 16-gap stack, as the loaded cards do. Without either the children render as they are (each `FormSection` or list says for
 * itself whether it is loading). One busy announcement.
 */
export function SettingsPage({
  header,
  nav,
  activeNav,
  actionRow,
  loading,
  children,
}: {
  header: PageHeaderProps;
  nav: SettingsNavGroup[];
  activeNav: string;
  actionRow?: ActionRowProps;
  loading?: {
    sections?: {
      fields?: number | FieldShape[];
      cards?: CardShape[];
      title?: string;
      description?: string;
    }[];
    cards?: CardShape[] | { shape?: CardShape; count?: number };
  };
  children?: ReactNode;
}) {
  const { description, ...head } = header;
  const Link = useDesignLink();
  const t = useDesignT();
  // On phones the sub-nav is one scrolling row above the content: keep the current item in view.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollLeft = current.offsetLeft - nav.offsetLeft;
  }, []);
  const rail = (
    <nav
      ref={navRef}
      className="cb-settings-nav"
      data-part="settings-nav"
      aria-label={t("settings.nav")}
    >
      {nav.map((g) => (
        <div key={g.group} className="cb-settings-nav-section">
          <span className="cb-settings-nav-group">{g.group}</span>
          {g.items.map((n) => (
            <Link
              key={n.id}
              href={n.href}
              className="cb-settings-nav-item"
              data-current={n.id === activeNav ? "true" : undefined}
              {...(n.id === activeNav ? { "aria-current": "page" as const } : {})}
            >
              <span>{n.label}</span>
              {n.count !== undefined ? (
                <span className="cb-settings-nav-count">{n.count}</span>
              ) : null}
              <LinkPendingMark />
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(head) : head} />
      <Body layout="single" width="content">
        <div className="cb-settings-grid">
          {rail}
          <div className="cb-settings-content">
            {description ? (
              <p className="cb-settings-description" data-part="settings-description">
                {description}
              </p>
            ) : null}
            {loading?.sections ? (
              loading.sections.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
                <LoadingFormSection key={i} {...s} />
              ))
            ) : loading?.cards !== undefined ? (
              <Stack gap={16}>
                <LoadingShapedCards
                  cards={
                    Array.isArray(loading.cards)
                      ? loading.cards
                      : Array.from(
                          { length: loading.cards.count ?? LOADING_CARDS },
                          () => (loading.cards as { shape?: CardShape }).shape ?? {},
                        )
                  }
                />
              </Stack>
            ) : (
              children
            )}
          </div>
        </div>
      </Body>
      {actionRow ? <ActionRow {...(loading ? loadingActionRow(actionRow) : actionRow)} /> : null}
    </>
  );
  return (
    <div className="cb-template" data-template="SettingsPage" data-width="content">
      {loading ? (
        <SkeletonGroup label={header.title || t("table.loading")}>{page}</SkeletonGroup>
      ) : (
        page
      )}
    </div>
  );
}
