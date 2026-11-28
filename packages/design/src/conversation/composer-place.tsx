import * as RD from "@radix-ui/react-dialog";
import { type JSX, type KeyboardEvent, type ReactNode, useState } from "react";
import { Button } from "../controls/button";
import { Icon } from "../icons/icon";
import { BottomSheetContent, BottomSheetFrame, SheetOptionList } from "../overlays/bottom-sheet";
import { SheetGroup, SheetRow } from "../overlays/sheet-parts";
import { useOverlayHistory } from "../overlays/use-overlay-history";
import { useDesignT } from "../provider";
import { Picker, type PickerProps } from "./composer";
import { shortDeviceLabel } from "./composer-options";

// The composer's top strip (spec §6.16.2 "Top strip", composer menus spec §6, §7): where the
// conversation runs, the device then its project. From 600 up two pickers with a muted "/" between
// them; below 600 one chip "<device> / <project>" opening a bottom sheet with a device group, then
// that device's projects. CSS shows one of the two forms.

/** The top strip's pickers: the device, then the project (absent when the device offers none). */
export type ComposerPlace = { device: PickerProps; project?: PickerProps };

/**
 * The top strip (§6.16.2): both forms in the DOM, the CSS of the size class showing one. A `locked`
 * picker is static text (a conversation's device and project); the compact chip is static text
 * when nothing in it can change.
 */
export function ComposerPlaceStrip({ device, project }: ComposerPlace): JSX.Element {
  const t = useDesignT();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of two pickers, not a form field set
    <div
      className="cb-composer-place"
      data-part="composer-place"
      role="group"
      aria-label={t("composer.place")}
    >
      <span className="cb-composer-place-full" data-part="composer-place-full">
        <Picker {...device} titled />
        {project ? (
          <>
            <span
              className="cb-composer-place-sep"
              data-part="composer-place-sep"
              aria-hidden="true"
            >
              /
            </span>
            <Picker {...project} titled />
          </>
        ) : null}
      </span>
      <ComposerPlaceChip device={device} {...(project ? { project } : {})} />
    </div>
  );
}

/** The chip's two parts: the device (without a trailing "device") and the project. */
function ChipValue({ device, project }: ComposerPlace): JSX.Element {
  return (
    <>
      <span className="cb-place-value" data-part="place-device">
        {shortDeviceLabel(device.value)}
      </span>
      {project ? (
        <>
          <span className="cb-place-sep" aria-hidden="true">
            /
          </span>
          <span className="cb-place-value" data-part="place-project">
            {project.value}
          </span>
        </>
      ) : null}
    </>
  );
}

/**
 * The compact form (§6.16.2): one chip reading "<device> / <project>" that opens the place sheet.
 * Picking a device keeps the sheet open (the project group follows it), picking a project closes it.
 */
export function ComposerPlaceChip({
  device,
  project,
  referenceSheet,
}: ComposerPlace & {
  /** The reference set and the catalog only: the sheet drawn open in place over `page`. */
  referenceSheet?: { page?: ReactNode };
}): JSX.Element {
  const t = useDesignT();
  const [open, setOpen] = useState(false);
  // Back closes the open sheet first on a compact touch window (mobile app plan Decision 25).
  const history = useOverlayHistory(open, () => setOpen(false));
  const full = [device.value, project?.value].filter((v): v is string => v !== undefined);
  const name = `${t("composer.place")}: ${full.join(" / ")}`;
  const title = t("composer.place");
  const runAction = (action: PickerProps["action"]) => {
    if (action !== undefined) history.leaveEntry();
    setOpen(false);
    action?.onSelect();
  };
  const body = (
    <PlaceSheetBody
      device={device}
      {...(project ? { project } : {})}
      onPickProject={(id) => {
        project?.onPick(id);
        setOpen(false);
      }}
      onAction={runAction}
    />
  );
  if (referenceSheet) {
    return (
      <BottomSheetFrame title={title} state="idle" share={0} page={referenceSheet.page}>
        {body}
      </BottomSheetFrame>
    );
  }
  // a locked or disabled picker cannot change: with none left to change the chip is static text
  const can = (p?: PickerProps) => p !== undefined && !p.locked && p.disabled !== true;
  const changeable = can(device) || can(project);
  if (!changeable) {
    const hints = [device.locked?.hint, project?.locked?.hint].filter((h): h is string =>
      Boolean(h),
    );
    const title = hints.length > 0 ? `${full.join(" / ")}: ${hints.join("; ")}` : full.join(" / ");
    // A locked picker's warning (a project that is no longer there) stays reachable on a phone:
    // the chip shows its mark and opens what the warning inspects.
    const warning = device.locked?.warning ?? project?.locked?.warning;
    if (warning) {
      return (
        <Button
          variant="ghost"
          className="cb-composer-place-chip"
          part="composer-place-chip"
          data-locked="true"
          aria-label={`${name} · ${warning.label}`}
          title={title}
          onClick={warning.onInspect}
        >
          <ChipValue device={device} {...(project ? { project } : {})} />
          <span className="cb-picker-warning" data-part="place-warning">
            <Icon name="circle-alert" size={12} />
            {warning.label}
          </span>
        </Button>
      );
    }
    return (
      <span
        className="cb-composer-place-chip"
        data-part="composer-place-chip"
        data-locked="true"
        title={title}
      >
        <ChipValue device={device} {...(project ? { project } : {})} />
        {/* the lock reason is announced, not only shown on hover */}
        {hints.length > 0 ? (
          <span className="cb-sr-only" data-part="place-hint">
            {hints.join("; ")}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Trigger asChild>
        <Button
          variant="ghost"
          className="cb-composer-place-chip"
          part="composer-place-chip"
          aria-label={name}
          title={full.join(" / ")}
        >
          {device.icon ? <Icon name={device.icon} size={12} /> : null}
          <ChipValue device={device} {...(project ? { project } : {})} />
          <Icon name="chevron-down" size={12} />
        </Button>
      </RD.Trigger>
      <BottomSheetContent
        title={title}
        part="composer-place-sheet"
        onDismiss={() => setOpen(false)}
      >
        {body}
      </BottomSheetContent>
    </RD.Root>
  );
}

/** The place sheet's body: a group for the device, then one for that device's projects. */
function PlaceSheetBody({
  device,
  project,
  onPickProject,
  onAction,
}: ComposerPlace & {
  onPickProject(id: string): void;
  onAction(action: PickerProps["action"]): void;
}): JSX.Element {
  const t = useDesignT();
  return (
    <div className="cb-place-sheet" data-part="place-sheet">
      <PlaceGroup
        group="device"
        title={t("composer.options.device")}
        picker={device}
        onPick={device.onPick}
        onAction={onAction}
      />
      {project ? (
        <PlaceGroup
          group="project"
          title={t("composer.place.project")}
          picker={project}
          onPick={onPickProject}
          onAction={onAction}
        />
      ) : null}
    </div>
  );
}

/**
 * The arrow keys move the focus between a group's radios without picking (a radio's own arrows
 * would check the next one, and a project pick closes the sheet); Enter picks the focused one.
 * Space and a tap pick through the radio's change, as everywhere else.
 */
function moveWithoutPicking(e: KeyboardEvent<HTMLElement>, onPick: (id: string) => void): void {
  const target = e.target;
  if (e.nativeEvent.isComposing) return;
  if (!(target instanceof HTMLInputElement) || target.type !== "radio") return;
  const radios = [
    ...e.currentTarget.querySelectorAll<HTMLInputElement>('input[type="radio"]:not(:disabled)'),
  ];
  const at = radios.indexOf(target);
  if (e.key === "ArrowDown" || e.key === "ArrowRight") {
    e.preventDefault();
    radios[at + 1]?.focus();
  } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
    e.preventDefault();
    radios[at - 1]?.focus();
  } else if (e.key === "Enter") {
    e.preventDefault();
    onPick(target.value);
  }
}

/**
 * One picker in the place sheet: its groups as single-choice option lists under a heading (the
 * picker's title, then each further group's label), its notice, action and note; a locked picker
 * is its value read-only with the hint.
 */
function PlaceGroup({
  group,
  title,
  picker,
  onPick,
  onAction,
}: {
  group: "device" | "project";
  title: string;
  picker: PickerProps;
  onPick(id: string): void;
  onAction(action: PickerProps["action"]): void;
}): JSX.Element {
  const empty = !picker.locked && picker.groups.every((g) => g.items.length === 0);
  return (
    <section
      className="cb-place-group"
      data-part="place-group"
      data-group={group}
      onKeyDownCapture={(e) => moveWithoutPicking(e, onPick)}
    >
      {empty ? (
        // nothing to choose yet (the projects loading): the heading still names the group, the
        // picker's notice under it says why
        <h3 className="cb-sheet-group-heading" data-part="sheet-group-heading">
          {title}
        </h3>
      ) : null}
      {picker.notice ? (
        <p className="cb-options-sheet-note" data-part="place-notice">
          {picker.notice}
        </p>
      ) : null}
      {picker.locked ? (
        <SheetGroup heading={title} part="place-locked">
          <SheetRow static label={picker.value} description={picker.locked.hint} />
        </SheetGroup>
      ) : (
        picker.groups
          .filter((g) => g.items.length > 0)
          .map((g, i) => (
            <SheetGroup
              // biome-ignore lint/suspicious/noArrayIndexKey: a picker's groups have no ids; their order is fixed
              key={i}
              heading={i === 0 ? title : (g.label ?? title)}
              part="sheet-group"
            >
              <SheetOptionList
                label={g.label ?? title}
                options={g.items.map((it) => ({
                  id: it.id,
                  label: it.label,
                  ...(it.tag ? { tag: it.tag } : {}),
                  ...(it.badge ? { badge: it.badge } : {}),
                  ...(it.badgeTone ? { badgeTone: it.badgeTone } : {}),
                  ...(it.checked ? { checked: true } : {}),
                  ...(it.disabled || picker.disabled ? { disabled: true } : {}),
                }))}
                onPick={(id) => {
                  const item = g.items.find((it) => it.id === id);
                  if (!item || item.disabled === true || picker.disabled === true) return;
                  onPick(id);
                }}
              />
            </SheetGroup>
          ))
      )}
      {picker.action && !picker.locked ? (
        <Button
          variant="ghost"
          density="dense"
          className="cb-options-action"
          onClick={() => onAction(picker.action)}
        >
          {picker.action.icon ? <Icon name={picker.action.icon} size={14} /> : null}
          {picker.action.label}
        </Button>
      ) : null}
      {picker.note && !picker.locked ? (
        <p className="cb-options-sheet-note">{picker.note}</p>
      ) : null}
    </section>
  );
}
