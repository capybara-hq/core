import { Button } from "../controls/index";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

export type ButtonSpec = {
  label: string;
  onSelect(): void;
  shortcut?: string;
  loading?: boolean;
  disabled?: boolean;
};

export type ActionRowProps = {
  /** Unsaved changes; `0` reads "No unsaved changes", leaving it out shows nothing. */
  unsaved?: number;
  errors?: number;
  cancel?: { label: string; onSelect(): void };
  secondary?: ButtonSpec;
  primary: ButtonSpec;
};

function optional(b: ButtonSpec) {
  return {
    ...(b.shortcut !== undefined ? { shortcut: b.shortcut } : {}),
    ...(b.loading !== undefined ? { loading: b.loading } : {}),
    ...(b.disabled !== undefined ? { disabled: b.disabled } : {}),
  };
}

/**
 * The action row (spec §4.4): above the StatusBar when a page has actions to submit. Left: an
 * accent dot + unsaved count · error count (`fail`, `circle-alert`), or "No unsaved changes";
 * right: cancel · secondary · primary (rightmost), all `default` density.
 */
export function ActionRow({ unsaved, errors = 0, cancel, secondary, primary }: ActionRowProps) {
  const t = useDesignT();
  const fill = (key: "shell.unsaved" | "shell.errors", n: number) =>
    t(key).replace("{n}", () => String(n));
  const dirty = (unsaved ?? 0) > 0;
  return (
    <section className="cb-actionrow" data-part="action-row" aria-label={t("shell.pending")}>
      <span className="cb-actionrow-info">
        {dirty ? <span className="cb-actionrow-dot" aria-hidden="true" /> : null}
        {dirty ? <span>{fill("shell.unsaved", unsaved ?? 0)}</span> : null}
        {dirty && errors > 0 ? (
          <span className="cb-actionrow-sep" aria-hidden="true">
            ·
          </span>
        ) : null}
        {errors > 0 ? (
          <span className="cb-actionrow-errors" data-part="action-row-errors">
            <Icon name="circle-alert" size={14} />
            {fill("shell.errors", errors)}
          </span>
        ) : null}
        {unsaved === 0 && errors === 0 ? <span>{t("shell.clean")}</span> : null}
      </span>
      <span className="cb-actionrow-actions">
        {cancel ? (
          <Button variant="default" density="default" onClick={cancel.onSelect}>
            {cancel.label}
          </Button>
        ) : null}
        {secondary ? (
          <Button
            variant="default"
            density="default"
            {...optional(secondary)}
            onClick={secondary.onSelect}
          >
            {secondary.label}
          </Button>
        ) : null}
        <Button
          variant="primary"
          density="default"
          {...optional(primary)}
          onClick={primary.onSelect}
        >
          {primary.label}
        </Button>
      </span>
    </section>
  );
}
