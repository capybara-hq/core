import * as RD from "@radix-ui/react-dialog";
import { type JSX, useId, useState } from "react";
import { Button, IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import type { PickerProps } from "./composer";

// The composer's options button (spec §6.16.2, phones): below 640 the device, model and
// effort pickers collapse into one compact button that opens a bottom sheet with the three groups.

/**
 * A model's name for the options button: without a vendor path ("deepseek/…") and a date or
 * "latest" suffix; the CSS cuts what is still too long with an ellipsis.
 */
export function shortModelLabel(label: string): string {
  const s = label
    .replace(/^.*\//, "")
    .replace(/[-_ ]?(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/i, "")
    .trim();
  return s || label;
}

/** A device's name for the options button: without a trailing 「设备」 / "device". */
export function shortDeviceLabel(label: string): string {
  const s = label.replace(/\s*(设备|device)$/i, "").trim();
  return s || label;
}

export type ComposerOptionsProps = {
  device?: PickerProps;
  model: PickerProps;
  effort?: PickerProps;
};

/**
 * One compact button (`DeepSeek · 高 · 个人`) for the device, model and effort pickers,
 * opening a bottom sheet with one group each. The groups reuse the pickers' props: their items
 * (disabled ones with their reason), their notes, and a locked picker (a conversation's
 * device) shown read-only with its hint. Choosing an item calls the picker's `onPick` and
 * keeps the sheet open, so all three can be set in one go.
 */
export function ComposerOptions({ device, model, effort }: ComposerOptionsProps): JSX.Element {
  const t = useDesignT();
  const [open, setOpen] = useState(false);
  const full = [model.value, effort?.value, device?.value].filter(
    (v): v is string => v !== undefined,
  );
  const name = t("composer.options");
  const groups: { key: string; title: string; picker: PickerProps }[] = [
    ...(device ? [{ key: "device", title: t("composer.options.device"), picker: device }] : []),
    { key: "model", title: t("composer.options.model"), picker: model },
    ...(effort ? [{ key: "effort", title: t("composer.options.effort"), picker: effort }] : []),
  ];
  const body = (
    <>
      <header className="cb-bsheet-head" data-part="bsheet-head">
        <RD.Title className="cb-bsheet-title">{name}</RD.Title>
        <span className="cb-grow" />
        <RD.Close asChild>
          <IconButton label={t("overlay.close")} icon={<Icon name="x" size={16} />} />
        </RD.Close>
      </header>
      <div className="cb-bsheet-body" data-part="bsheet-body">
        {groups.map((g) => (
          <OptionsGroup key={g.key} group={g.key} title={g.title} picker={g.picker} />
        ))}
      </div>
    </>
  );
  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Trigger asChild>
        <Button
          variant="ghost"
          className="cb-composer-options"
          part="composer-options"
          aria-label={`${name}: ${full.join(" · ")}`}
          title={full.join(" · ")}
        >
          <span className="cb-options-value" data-part="options-model">
            {shortModelLabel(model.value)}
          </span>
          {effort ? (
            <>
              <span className="cb-options-sep" aria-hidden="true">
                ·
              </span>
              <span className="cb-options-value" data-part="options-effort" data-short="true">
                {effort.value}
              </span>
            </>
          ) : null}
          {device ? (
            <>
              <span className="cb-options-sep" aria-hidden="true">
                ·
              </span>
              <span className="cb-options-value" data-part="options-device">
                {shortDeviceLabel(device.value)}
              </span>
            </>
          ) : null}
          <Icon name="chevron-down" size={12} />
        </Button>
      </RD.Trigger>
      <RD.Portal>
        <RD.Overlay className="cb-bsheet-scrim" data-part="bsheet-scrim" />
        <RD.Content
          className="cb-bsheet"
          data-part="composer-options-sheet"
          aria-describedby={undefined}
        >
          {body}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/** One group of the options sheet: a picker's items as radios, or its locked value read-only. */
function OptionsGroup({
  group,
  title,
  picker,
}: {
  group: string;
  title: string;
  picker: PickerProps;
}): JSX.Element {
  const id = useId();
  const titleId = `${id}-title`;
  return (
    <section
      className="cb-options-group"
      data-part="options-group"
      data-group={group}
      aria-labelledby={titleId}
    >
      <h3 className="cb-options-title" id={titleId}>
        {title}
      </h3>
      {picker.locked ? (
        <p className="cb-options-locked" data-part="options-locked" data-locked="true">
          <span className="cb-options-locked-value">{picker.value}</span>
          <span className="cb-options-hint">{picker.locked.hint}</span>
        </p>
      ) : (
        <div className="cb-options-list" role="radiogroup" aria-labelledby={titleId}>
          {picker.groups.map((g, gi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the picker's groups have no ids; their order is fixed
            <div key={gi} className="cb-options-sub">
              {g.label ? <div className="cb-options-label">{g.label}</div> : null}
              {g.items.map((it) => {
                const disabled = picker.disabled === true || it.disabled === true;
                return (
                  <label
                    key={it.id}
                    className="cb-options-item"
                    data-part="options-item"
                    data-checked={it.checked ? "true" : undefined}
                    data-disabled={disabled ? "true" : undefined}
                  >
                    <input
                      type="radio"
                      className="cb-sr-only"
                      name={id}
                      value={it.id}
                      checked={it.checked === true}
                      disabled={disabled}
                      onChange={() => picker.onPick(it.id)}
                    />
                    <span className="cb-options-text">{it.label}</span>
                    {it.tag ? <span className="cb-cmenu-tag">{it.tag}</span> : null}
                    <span className="cb-grow" />
                    {it.checked ? (
                      <span className="cb-options-check">
                        <Icon name="check" size={14} />
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      )}
      {picker.note && !picker.locked ? <p className="cb-options-note">{picker.note}</p> : null}
    </section>
  );
}
