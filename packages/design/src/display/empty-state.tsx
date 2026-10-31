import { isValidElement, type ReactElement } from "react";
import { Button } from "../controls/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
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
   * Replaces the pixel capybara where an object icon reads better (a failed load, a search that
   * matched nothing).
   */
  icon?: IconName;
  /**
   * `page` (default): centered in the content frame with generous space above and below.
   * `compact`: panels, tables and the sidebar; a smaller illustration, left-aligned text.
   */
  size?: "page" | "compact";
};

/**
 * The one empty state (spec §6.18): the pixel capybara drawn in faint lines (or an `icon`), one
 * sentence in ink, an optional muted second line and the primary action. Used by every list
 * page, the inbox, the DataTable's empty area and the sidebar's conversation list.
 */
export function EmptyState({ text, hint, action, icon, size = "page" }: EmptyStateProps) {
  const Link = useDesignLink();
  const compact = size === "compact";
  return (
    <div className="cb-empty-state" data-part="empty-state" data-size={size}>
      {icon ? (
        <span className="cb-empty-state-icon" data-part="empty-state-icon" aria-hidden="true">
          <Icon name={icon} size={compact ? 14 : 16} />
        </span>
      ) : (
        <span className="cb-empty-state-art" data-part="empty-illustration" aria-hidden="true">
          <LogoLine scale={compact ? 3 : 6} />
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
          {renderAction(action as Exclude<HeaderAction, { menu: unknown }>, Link, compact)}
        </span>
      )}
    </div>
  );
}

function renderAction(
  action: Exclude<HeaderAction, { menu: unknown }>,
  Link: ReturnType<typeof useDesignLink>,
  compact: boolean,
) {
  const density = compact ? "dense" : "default";
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
