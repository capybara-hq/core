import { isValidElement, type ReactElement } from "react";
import { Button } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignLink } from "../provider";
import type { HeaderAction } from "../shell/page-header";
import { LogoLine } from "./logo";

export type EmptyStateProps = {
  /** One sentence saying what will be here (ink). */
  text: string;
  /** An optional second line (muted). */
  hint?: string;
  /**
   * The primary action: a button or a link (the menu kind is not drawn here), or a ready element
   * (the DataTable's own `empty.action`).
   */
  action?: Exclude<HeaderAction, { menu: unknown }> | ReactElement;
  /**
   * `page` (default): a page or settings content area with nothing to show; the line-art capybara,
   * centered in the content frame with generous space above and below. `panel`: an empty region
   * inside a box (a card, a form card, a Sheet, a Dialog, a right panel, a properties section, the
   * sidebar); the same centered look with a smaller capybara, `space.8` above and below and a dense
   * action. `compact`: only where the space is one line (the DataTable's empty area); the sentence
   * alone, no art.
   */
  size?: "page" | "panel" | "compact";
};

/**
 * The empty state (spec §6.18), in three styles: `page`, the pixel capybara drawn in faint lines
 * over one sentence in ink, an optional muted second line and the primary action; `panel`, the
 * same centered look sized for an empty region inside a box (the capybara at scale 4, a dense
 * action): an ItemList, a Sheet, a Dialog, a right panel, the sidebar's conversation list; and
 * `compact`, the same words without the art, for the DataTable's empty area. Used by every list
 * page, the inbox, every ItemList, the DataTable and the sidebar.
 */
export function EmptyState({ text, hint, action, size = "page" }: EmptyStateProps) {
  const Link = useDesignLink();
  const compact = size === "compact";
  const dense = size !== "page";
  return (
    <div className="cb-empty-state" data-part="empty-state" data-size={size}>
      {compact ? null : (
        <span className="cb-empty-state-art" data-part="empty-illustration" aria-hidden="true">
          <LogoLine scale={size === "panel" ? 4 : 6} />
        </span>
      )}
      <span className="cb-empty-state-words">
        <p className="cb-empty-state-text" data-part="empty-state-text">
          {text}
        </p>
        {hint ? (
          <p className="cb-empty-state-hint" data-part="empty-state-hint">
            {hint}
          </p>
        ) : null}
      </span>
      {action === undefined ? null : isValidElement(action) ? (
        <span className="cb-empty-state-action">{action}</span>
      ) : (
        <span className="cb-empty-state-action">
          {renderAction(action as Exclude<HeaderAction, { menu: unknown }>, Link, dense)}
        </span>
      )}
    </div>
  );
}

function renderAction(
  action: Exclude<HeaderAction, { menu: unknown }>,
  Link: ReturnType<typeof useDesignLink>,
  dense: boolean,
) {
  const density = dense ? "dense" : "default";
  if (action.href !== undefined) {
    return (
      <Link
        href={action.href}
        className={`cb-btn cb-btn-link cb-btn-link-${action.variant}`}
        data-density={density}
      >
        <span className="cb-btn-body">
          {action.icon ? <Icon name={action.icon} size={14} /> : null}
          {action.label}
        </span>
      </Link>
    );
  }
  return (
    <Button
      variant={action.variant}
      density={density}
      {...(action.onSelect ? { onClick: action.onSelect } : {})}
    >
      {action.icon ? <Icon name={action.icon} size={14} /> : null}
      {action.label}
    </Button>
  );
}
