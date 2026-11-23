import * as RD from "@radix-ui/react-dialog";
import {
  type JSX,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../controls/button";
import { Badge } from "../display/basic";
import { Segmented } from "../display/tabs";
import { Icon } from "../icons/icon";
import { BottomSheetContent, SheetOptionList } from "../overlays/bottom-sheet";
import { focusOnOpen, lastInputWasKey } from "../overlays/quiet-focus";
import { SheetGroup, SheetRow } from "../overlays/sheet-parts";
import { useOverlayHistory } from "../overlays/use-overlay-history";
import { useDesignT } from "../provider";
import { useMobileSizes } from "../shell/touch";
import type { PickerProps } from "./composer";
import {
  arrangePickerGroups,
  filterPickerGroups,
  LONG_PICKER_THRESHOLD,
  pickerItemCount,
} from "./picker-groups";

// The composer's options button (spec §6.16.2, phones): below 600 the device, permission, model
// and effort pickers collapse into one compact button with a bottom sheet group per picker; the
// model is one row that drills into a model page inside the sheet (§6.59 "In-sheet drill-in").

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
  permission?: PickerProps;
  model: PickerProps;
  effort?: PickerProps;
};

/**
 * One compact button (`DeepSeek · High · Personal`) for the device, permission, model and effort pickers,
 * opening a bottom sheet with one group each. The groups reuse the pickers' props: their items
 * (disabled ones with their reason), their notes, and a locked picker (a conversation's
 * device) shown read-only with its hint. Choosing an item calls the picker's `onPick` and
 * keeps the sheet open, so all choices can be set in one go. The model is one row (Model ·
 * current model ›) that opens the model page in the same sheet: a search field above
 * {@link LONG_PICKER_THRESHOLD} models, the current and the pinned (agent default) models first,
 * then the provider groups; a pick goes back to the options. The accessible summary also
 * includes the full permission value when supplied.
 */
export function ComposerOptions({
  device,
  permission,
  model,
  effort,
}: ComposerOptionsProps): JSX.Element {
  const t = useDesignT();
  const [open, setOpenState] = useState(false);
  // The sheet's page: the options, or the model page drilled into from the model row.
  const [page, setPage] = useState<"options" | "model">("options");
  // a closed sheet opens on the options again
  const setOpen = (o: boolean) => {
    setOpenState(o);
    if (!o) setPage("options");
  };
  // Back closes the open sheet first on a compact touch window (mobile app plan Decision 25).
  const history = useOverlayHistory(open, () => setOpen(false));
  const modelRow = useRef<HTMLButtonElement>(null);
  const modelPage = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // The focus follows the page: on a push the search field from the keyboard (a tap never
  // raises the keyboard), else the checked or first model; on a pop the model row.
  const lastPage = useRef(page);
  useEffect(() => {
    if (lastPage.current === page) return;
    lastPage.current = page;
    // closing resets the page; the sheet returns the focus to its button itself
    if (!open) return;
    if (page === "model") {
      const radios = modelPage.current?.querySelectorAll<HTMLInputElement>(
        'input[type="radio"]:not(:disabled)',
      );
      const item = [...(radios ?? [])].find((r) => r.checked) ?? radios?.[0];
      focusOnOpen(lastInputWasKey() && search.current ? search.current : (item ?? search.current));
    } else {
      focusOnOpen(modelRow.current);
    }
  }, [page, open]);
  // the mobile form of the sheet (a Segmented for the effort, the note) follows the mobile sizes
  const touch = useMobileSizes() === true;
  const full = [
    model.value,
    effort?.value,
    device?.value,
    permission?.value,
    device?.locked?.warning?.label,
  ].filter((v): v is string => v !== undefined);
  const name = t("composer.options");
  const groups: { key: string; title: string; picker: PickerProps }[] = [
    ...(device ? [{ key: "device", title: t("composer.options.device"), picker: device }] : []),
    ...(permission
      ? [{ key: "permission", title: t("composer.options.permission"), picker: permission }]
      : []),
    { key: "model", title: t("composer.options.model"), picker: model },
    ...(effort ? [{ key: "effort", title: t("composer.options.effort"), picker: effort }] : []),
  ];
  const inspect = (picker: PickerProps) => {
    // inspecting may navigate: leave the entry rather than race the router's push
    history.leaveEntry();
    setOpen(false);
    picker.locked?.warning?.onInspect();
  };
  const runAction = (action: PickerProps["action"]) => {
    if (action !== undefined) history.leaveEntry();
    setOpen(false);
    action?.onSelect();
  };
  const body = (
    <>
      {groups.map((g) =>
        g.key === "model" && !g.picker.locked ? (
          <section
            key={g.key}
            className="cb-options-group"
            data-part="options-group"
            data-group="model"
          >
            <SheetGroup part="options-model-group">
              <SheetRow
                ref={modelRow}
                icon="cpu"
                label={g.title}
                value={g.picker.value}
                chevron
                part="options-model"
                disabled={g.picker.disabled === true}
                onClick={() => setPage("model")}
              />
            </SheetGroup>
            {g.picker.notice ? (
              <p className="cb-options-sheet-note" data-part="options-notice">
                {g.picker.notice}
              </p>
            ) : null}
          </section>
        ) : (
          <OptionsGroup
            key={g.key}
            group={g.key}
            segmented={touch && g.key === "effort"}
            title={g.title}
            picker={g.picker}
            onInspect={() => inspect(g.picker)}
            onAction={runAction}
          />
        ),
      )}
    </>
  );
  return (
    <RD.Root open={open} onOpenChange={setOpen}>
      <RD.Trigger asChild>
        <Button
          variant="ghost"
          className="cb-composer-options"
          part="composer-options"
          data-cap-part="button composer.options"
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
          {device?.locked?.warning ? (
            <span className="cb-picker-warning" data-part="options-warning">
              <Icon name="circle-alert" size={12} />
            </span>
          ) : null}
          <Icon name="chevron-down" size={12} />
        </Button>
      </RD.Trigger>
      <BottomSheetContent
        title={page === "model" ? t("composer.options.model") : name}
        part="composer-options-sheet"
        onDismiss={() => setOpen(false)}
        page={page}
        back={
          page === "model"
            ? { label: t("composer.options.back"), onBack: () => setPage("options") }
            : undefined
        }
      >
        {page === "model" ? (
          <ModelPage
            picker={model}
            pageRef={modelPage}
            searchRef={search}
            onPicked={() => setPage("options")}
            onAction={runAction}
          />
        ) : (
          <>
            {body}
            {touch ? (
              <p className="cb-options-sheet-note" data-part="options-note">
                {t("composer.options.note")}
              </p>
            ) : null}
          </>
        )}
      </BottomSheetContent>
    </RD.Root>
  );
}

/** One group of the options sheet: a picker's items as radios, or its locked value read-only. */
function OptionsGroup({
  group,
  segmented,
  title,
  picker,
  onInspect,
  onAction,
}: {
  group: string;
  /** Touch: the picker's few items as one segmented control (thinking low / medium / high). */
  segmented: boolean;
  title: string;
  picker: PickerProps;
  onInspect(): void;
  /** The picker's action: the sheet closes first. */
  onAction(action: PickerProps["action"]): void;
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
      {picker.notice ? (
        <p className="cb-options-sheet-note" data-part="options-notice">
          {picker.notice}
        </p>
      ) : null}
      {picker.locked ? (
        <p className="cb-options-locked" data-part="options-locked" data-locked="true">
          <span className="cb-options-locked-value">{picker.value}</span>
          <span className="cb-options-hint">{picker.locked.hint}</span>
          {picker.locked.warning ? (
            <Button variant="ghost" density="dense" onClick={onInspect}>
              <span className="cb-picker-warning">
                <Icon name="circle-alert" size={12} />
                {picker.locked.warning.label}
              </span>
            </Button>
          ) : null}
        </p>
      ) : segmented && picker.groups.length === 1 ? (
        <SegmentedItems title={title} picker={picker} />
      ) : (
        <div className="cb-options-list" role="radiogroup" aria-labelledby={titleId}>
          {picker.groups.map((g, gi) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the picker's groups have no ids; their order is fixed
            <div key={gi} className="cb-options-sub">
              {g.label ? <div className="cb-options-label">{g.label}</div> : null}
              {g.items.map((it) => {
                const disabled = picker.disabled === true || it.disabled === true;
                // a described item: named by its label and tag, its sentence the description
                const itemId = `${id}-${it.id}`;
                const described = it.description !== undefined;
                const head = (
                  <>
                    <span className="cb-options-text" id={`${itemId}-label`}>
                      {it.label}
                    </span>
                    {it.tag ? (
                      <span className="cb-cmenu-tag" id={`${itemId}-tag`}>
                        {it.tag}
                      </span>
                    ) : null}
                    {it.badge ? <Badge tone={it.badgeTone ?? "warn"}>{it.badge}</Badge> : null}
                  </>
                );
                return (
                  <label
                    key={it.id}
                    className="cb-options-item"
                    data-part="options-item"
                    data-checked={it.checked ? "true" : undefined}
                    data-disabled={disabled ? "true" : undefined}
                    data-described={described ? "true" : undefined}
                  >
                    <input
                      type="radio"
                      className="cb-sr-only"
                      name={id}
                      value={it.id}
                      checked={it.checked === true}
                      disabled={disabled}
                      onChange={() => picker.onPick(it.id)}
                      {...(described
                        ? {
                            "aria-labelledby": it.tag
                              ? `${itemId}-label ${itemId}-tag`
                              : `${itemId}-label`,
                            "aria-describedby": `${itemId}-desc`,
                          }
                        : {})}
                    />
                    {it.icon ? <Icon name={it.icon} size={14} /> : null}
                    {described ? (
                      <span className="cb-options-body">
                        <span className="cb-options-head">{head}</span>
                        <span
                          className="cb-options-desc"
                          data-part="options-desc"
                          id={`${itemId}-desc`}
                        >
                          {it.description}
                        </span>
                      </span>
                    ) : (
                      head
                    )}
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
      {picker.note && !picker.locked ? <p className="cb-options-note">{picker.note}</p> : null}
    </section>
  );
}

/** A picker's items as a `Segmented`: a change picks the item (and plays the selection haptic). */
function SegmentedItems({ title, picker }: { title: string; picker: PickerProps }): JSX.Element {
  const items = picker.groups.flatMap((g) => g.items);
  const checked = items.find((i) => i.checked)?.id ?? "";
  return (
    <Segmented
      fill
      label={title}
      value={checked}
      options={items.map((i) => ({ value: i.id, label: i.label }))}
      onChange={(id) => {
        const item = items.find((i) => i.id === id);
        if (item && item.disabled !== true && picker.disabled !== true) picker.onPick(id);
      }}
    />
  );
}

/**
 * The model page of the options sheet (§6.16.2, §6.59 "In-sheet drill-in"): above
 * {@link LONG_PICKER_THRESHOLD} models a search field over the list (matching the model and the
 * provider names), the current and pinned models in a group of their own, then one group per
 * provider, each a `SheetOptionList`. ↑/↓ move between the models (and up into the search
 * field) without picking; Space, Enter or a tap picks and goes back. Enter in the field picks the
 * first match.
 */
function ModelPage({
  picker,
  pageRef,
  searchRef,
  onPicked,
  onAction,
}: {
  picker: PickerProps;
  pageRef: RefObject<HTMLDivElement | null>;
  searchRef: RefObject<HTMLInputElement | null>;
  onPicked(): void;
  onAction(action: PickerProps["action"]): void;
}): JSX.Element {
  const t = useDesignT();
  const [query, setQuery] = useState("");
  const searchable = pickerItemCount(picker.groups) > LONG_PICKER_THRESHOLD;
  const groups = filterPickerGroups(
    arrangePickerGroups(picker.groups, t("composer.models.pinned")),
    searchable ? query : "",
  );
  const pick = (id: string) => {
    const item = picker.groups.flatMap((g) => g.items).find((it) => it.id === id);
    if (!item || item.disabled === true || picker.disabled === true) return;
    picker.onPick(id);
    onPicked();
  };
  const radios = () => [
    ...(pageRef.current?.querySelectorAll<HTMLInputElement>('input[type="radio"]:not(:disabled)') ??
      []),
  ];
  // The list is one column across its groups: ↑/↓ move the focus (a radio's own arrows would
  // pick, and stop at its group), Enter picks as Space does.
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    const target = e.target;
    if (target === searchRef.current) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        radios()[0]?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const first = groups.flatMap((g) => g.items).find((it) => it.disabled !== true);
        if (first) pick(first.id);
      }
      return;
    }
    if (!(target instanceof HTMLInputElement) || target.type !== "radio") return;
    const all = radios();
    const at = all.indexOf(target);
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      all[at + 1]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (at <= 0) searchRef.current?.focus();
      else all[at - 1]?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(target.value);
    }
  };
  const empty = groups.length === 0;
  return (
    <div
      ref={pageRef}
      className="cb-options-models"
      data-part="options-models"
      onKeyDownCapture={onKeyDownCapture}
    >
      {searchable ? (
        <input
          ref={searchRef}
          type="search"
          className="cb-cmenu-filter cb-options-search"
          data-part="options-model-search"
          value={query}
          placeholder={t("composer.models.search")}
          aria-label={t("composer.models.search")}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      {picker.notice ? (
        <p className="cb-options-sheet-note" data-part="options-notice">
          {picker.notice}
        </p>
      ) : null}
      {groups.map((g) => (
        <SheetGroup
          key={g.key}
          {...(g.label ? { heading: g.label } : { label: picker.label })}
          part={g.pinned ? "options-model-pinned" : "options-model-group"}
        >
          <SheetOptionList
            label={g.label ?? picker.label}
            options={g.items.map((it) => ({
              id: it.id,
              label: it.label,
              ...(it.tag ? { tag: it.tag } : {}),
              ...(it.badge ? { badge: it.badge } : {}),
              ...(it.badgeTone ? { badgeTone: it.badgeTone } : {}),
              ...(it.checked ? { checked: true } : {}),
              ...(it.disabled || picker.disabled ? { disabled: true } : {}),
            }))}
            onPick={pick}
          />
        </SheetGroup>
      ))}
      {/* always mounted, so a search that matches nothing is announced */}
      <div role="status" data-part="options-model-status">
        {empty ? <p className="cb-options-models-empty">{t("composer.models.noMatch")}</p> : null}
      </div>
      {picker.action ? (
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
      {picker.note ? <p className="cb-options-sheet-note">{picker.note}</p> : null}
    </div>
  );
}
