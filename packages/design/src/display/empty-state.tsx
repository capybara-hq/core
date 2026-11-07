import { isValidElement, type ReactElement } from "react";
import { Button } from "../controls/index";
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
   * `page` (default): the line-art capybara, centered in the content frame with generous space
   * above and below. `panel`: narrow areas (the sidebar's conversation list); the same centered
   * look with a smaller capybara, `space.8` above and below and a dense action. `compact`: panels,
   * cards and tables; the sentence alone, no art.
   */
  size?: "page" | "panel" | "compact";
};

/**
 * The empty state (spec §6.18), in three styles: `page`, the pixel capybara drawn in faint lines
 * over one sentence in ink, an optional muted second line and the primary action; `panel`, the
 * same centered look sized for a narrow area (the capybara at scale 4, a dense action), used by
 * the sidebar's conversation list; and `compact` (tables, panels, cards), the same words without
 * the art. Used by every list page, the inbox, the DataTable's empty area and the sidebar.
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
