import { type ReactNode, useId, useState } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

/**
 * A compact row of small fields (spec §6.27): one model of an endpoint's model list. Labels are
 * drawn on the first row only (`first`), later rows keep them as the fields' accessible names;
 * below 640 the row stacks with every label drawn. `advanced` fields sit behind a per-row
 * "高级" / "Advanced" disclosure at the row's end.
 */
export function FieldRow({
  children,
  advanced,
  first = false,
  defaultAdvancedOpen = false,
}: {
  children: ReactNode;
  advanced?: ReactNode;
  first?: boolean;
  /** Start with the advanced fields open (an issue inside them, the reference block). */
  defaultAdvancedOpen?: boolean;
}) {
  const t = useDesignT();
  const id = useId();
  const [open, setOpen] = useState(defaultAdvancedOpen);
  return (
    <div className="cb-field-row" data-part="field-row" data-first={first ? "true" : "false"}>
      <div className="cb-field-row-fields" data-part="field-row-fields">
        {children}
        {advanced ? (
          <button
            type="button"
            className="cb-field-row-toggle"
            data-part="field-row-toggle"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            onClick={() => setOpen((o) => !o)}
          >
            {t("fieldRow.advanced")}
            <span className="cb-field-row-caret" aria-hidden="true">
              <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
            </span>
          </button>
        ) : null}
      </div>
      {advanced && open ? (
        <div id={id} className="cb-field-row-more" data-part="field-row-more">
          {advanced}
        </div>
      ) : null}
    </div>
  );
}
