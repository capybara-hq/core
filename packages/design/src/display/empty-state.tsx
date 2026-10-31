import { Button } from "../controls/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignLink } from "../provider";
import type { HeaderAction } from "../shell/page-header";

export type EmptyStateProps = {
  icon: IconName;
  text: string;
  /** The primary action (a button or a link; the menu kind is not drawn here). */
  action?: Exclude<HeaderAction, { menu: unknown }>;
};

/**
 * The one empty state of a page: an icon, one sentence and the primary action (spec §6.18). The
 * table's own empty area (DataTable) stays inside the table.
 */
export function EmptyState({ icon, text, action }: EmptyStateProps) {
  const Link = useDesignLink();
  return (
    <div className="cb-empty-state">
      <Icon name={icon} size={16} />
      <p className="cb-empty-state-text">{text}</p>
      {action ? (
        action.href !== undefined ? (
          <Link href={action.href} className={`cb-btn cb-btn-link cb-btn-link-${action.variant}`}>
            <span className="cb-btn-body">
              {action.icon ? <Icon name={action.icon} size={14} /> : null}
              {action.label}
            </span>
          </Link>
        ) : (
          <Button
            variant={action.variant}
            density="default"
            {...(action.onSelect ? { onClick: action.onSelect } : {})}
          >
            {action.icon ? <Icon name={action.icon} size={14} /> : null}
            {action.label}
          </Button>
        )
      ) : null}
    </div>
  );
}
