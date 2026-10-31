import type { ReactNode } from "react";
import { Button } from "../controls/index";

export type DangerZoneItemProps = {
  title: string;
  description: ReactNode;
  /** The one irreversible action; it opens a confirmation, never acts at once. */
  action: { label: string; onSelect(): void; disabled?: boolean };
};

/**
 * The danger zone at the bottom of a settings section (spec §6.21): a labelled region with a
 * `fail` border, one row per irreversible action (title, description, a `danger` button).
 */
export function DangerZone({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="cb-danger-zone" data-part="danger-zone" aria-label={title}>
      <h2 className="cb-danger-zone-title">{title}</h2>
      <div className="cb-danger-zone-items">{children}</div>
    </section>
  );
}

export function DangerZoneItem({ title, description, action }: DangerZoneItemProps) {
  return (
    <div className="cb-danger-zone-item" data-part="danger-zone-item">
      <div className="cb-danger-zone-words">
        <span className="cb-danger-zone-item-title">{title}</span>
        <span className="cb-danger-zone-desc">{description}</span>
      </div>
      <Button
        variant="danger"
        density="dense"
        onClick={action.onSelect}
        {...(action.disabled ? { disabled: true } : {})}
      >
        {action.label}
      </Button>
    </div>
  );
}
