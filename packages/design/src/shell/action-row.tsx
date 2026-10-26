import { Button } from "../controls/index";
import { useDesignT } from "../provider";

export type ButtonSpec = {
  label: string;
  onSelect(): void;
  shortcut?: string;
  loading?: boolean;
  disabled?: boolean;
};

export type ActionRowProps = {
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

export function ActionRow({ unsaved = 0, errors = 0, cancel, secondary, primary }: ActionRowProps) {
  const t = useDesignT();
  const fill = (key: "shell.unsaved" | "shell.errors", n: number) =>
    t(key).replace("{n}", () => String(n));
  return (
    <section className="cb-actionrow" aria-label={t("shell.pending")}>
      <span className="cb-actionrow-info">
        {unsaved > 0 ? (
          <span className="cb-actionrow-unsaved">
            <span className="cb-actionrow-dot" aria-hidden="true" />
            {fill("shell.unsaved", unsaved)}
          </span>
        ) : null}
        {errors > 0 ? (
          <span className="cb-actionrow-errors">{`· ${fill("shell.errors", errors)}`}</span>
        ) : null}
      </span>
      <span className="cb-actionrow-actions">
        {cancel ? (
          <Button variant="ghost" onClick={cancel.onSelect}>
            {cancel.label}
          </Button>
        ) : null}
        {secondary ? (
          <Button variant="default" {...optional(secondary)} onClick={secondary.onSelect}>
            {secondary.label}
          </Button>
        ) : null}
        <Button variant="primary" {...optional(primary)} onClick={primary.onSelect}>
          {primary.label}
        </Button>
      </span>
    </section>
  );
}
