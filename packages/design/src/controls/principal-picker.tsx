import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { type ArrangedPickerGroup, filterPickerGroups } from "../conversation/picker-groups";
import { Avatar, type AvatarValue } from "../display/avatar";
import { Icon } from "../icons/icon";
import { useHaptics } from "../native";
import { BottomSheet, BottomSheetFrame } from "../overlays/bottom-sheet";
import { Popover } from "../overlays/menus";
import { useDesignT } from "../provider";
import { ClassForms } from "../shell/class-forms";

// PrincipalPicker (spec §6.70; plugin full pages design §7): a combobox that picks people and
// agents, one or many. Built from the Popover, the composer picker's search field and list pieces
// (`cb-cmenu-filter`, picker-groups) and the Avatar; the compact class opens a bottom sheet.

/** One person or agent that can be picked. `hint` is one muted line under the name. */
export type PrincipalOption = {
  kind: "person" | "agent";
  id: string;
  name: string;
  avatar?: AvatarValue;
  hint?: string;
  /** Not choosable; its `hint` then says why. */
  disabled?: boolean;
};

export type PrincipalPickerProps = {
  options: PrincipalOption[];
  /** The chosen ids. */
  value: string[];
  onChange(ids: string[]): void;
  /** Several can be chosen: the list stays open and a pick toggles its id. */
  multiple?: boolean;
  /** Shown, `faint`, while nothing is chosen. */
  placeholder?: string;
  /** Group the list under 人员 / 智能体 headings. */
  groups?: boolean;
  /** Called with the raw text of the search field on every change, and `""` when it closes. */
  onSearch?(query: string): void;
  /** More options are on their way: a loading line follows the ones already known. */
  loading?: boolean;
  disabled?: boolean;
  /** The field's accessible name, and the compact sheet's title. */
  "aria-label"?: string;
};

type Item = { id: string; label: string; option: PrincipalOption };

function avatarOf(o: PrincipalOption, size: 16 | 24) {
  return (
    <Avatar
      shape={o.kind === "person" ? "circle" : "square"}
      size={size}
      name={o.name}
      value={o.avatar ?? null}
    />
  );
}

/** The groups a list draws: the options by kind under headings, or one headless group. */
function arrange(
  options: PrincipalOption[],
  grouped: boolean,
  headings: { person: string; agent: string },
  query: string,
): { key: string; label?: string; items: Item[] }[] {
  const item = (option: PrincipalOption): Item => ({
    id: option.id,
    label: option.name,
    option,
  });
  const base: ArrangedPickerGroup[] = grouped
    ? (["person", "agent"] as const).map((kind) => ({
        key: kind,
        label: headings[kind],
        items: options.filter((o) => o.kind === kind).map(item),
      }))
    : [{ key: "all", items: options.map(item) }];
  // `filterPickerGroups` keeps what it was given: the items carry their option along
  return filterPickerGroups(base, query) as unknown as {
    key: string;
    label?: string;
    items: Item[];
  }[];
}

type Model = {
  open: boolean;
  setOpen(open: boolean): void;
  query: string;
  setQuery(q: string): void;
  groups: { key: string; label?: string; items: Item[] }[];
  /** The enabled options in list order. */
  enabled: string[];
  active: string | null;
  setActive(id: string): void;
  choose(id: string): void;
  onKeyDown(e: KeyboardEvent<HTMLInputElement>): void;
};

function usePicker(p: PrincipalPickerProps): Model {
  const t = useDesignT();
  const haptics = useHaptics();
  const [open, setOpenState] = useState(false);
  const [query, setQueryState] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const groups = arrange(
    p.options,
    p.groups === true,
    { person: t("principalPicker.people"), agent: t("principalPicker.agents") },
    query,
  );
  const enabled = groups.flatMap((g) =>
    g.items.filter((i) => i.option.disabled !== true).map((i) => i.id),
  );
  const active = activeId !== null && enabled.includes(activeId) ? activeId : (enabled[0] ?? null);

  const setQuery = (q: string) => {
    setQueryState(q);
    setActiveId(null);
    p.onSearch?.(q);
  };
  const setOpen = (o: boolean) => {
    if (o && p.disabled === true) return;
    setOpenState(o);
    if (o) {
      const chosen = p.value.find((id) => p.options.some((x) => x.id === id && !x.disabled));
      setActiveId(chosen ?? null);
    } else if (query !== "") {
      setQueryState("");
      p.onSearch?.("");
    }
  };
  if (p.disabled === true && open) setOpen(false);

  const choose = (id: string) => {
    const option = p.options.find((o) => o.id === id);
    if (!option || option.disabled === true) return;
    if (p.multiple === true) {
      haptics("selection");
      p.onChange(p.value.includes(id) ? p.value.filter((v) => v !== id) : [...p.value, id]);
      return;
    }
    if (!(p.value.length === 1 && p.value[0] === id)) {
      haptics("selection");
      p.onChange([id]);
    }
    setOpen(false);
  };

  const step = (by: number) => {
    if (enabled.length === 0) return;
    const at = active === null ? -1 : enabled.indexOf(active);
    setActiveId(enabled[(at + by + enabled.length) % enabled.length] ?? null);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        return step(1);
      case "ArrowUp":
        e.preventDefault();
        return step(-1);
      case "Home":
        e.preventDefault();
        return setActiveId(enabled[0] ?? null);
      case "End":
        e.preventDefault();
        return setActiveId(enabled[enabled.length - 1] ?? null);
      case "Enter":
        e.preventDefault();
        if (active !== null) choose(active);
    }
  };
  return {
    open,
    setOpen,
    query,
    setQuery,
    groups,
    enabled,
    active,
    setActive: setActiveId,
    choose,
    onKeyDown,
  };
}

/** The field: the chosen avatar and name (`+N` for more), or the placeholder. */
function Value({
  options,
  value,
  placeholder,
}: {
  options: PrincipalOption[];
  value: string[];
  placeholder?: string | undefined;
}) {
  const first = value[0];
  const option = first === undefined ? undefined : options.find((o) => o.id === first);
  const more = value.length - 1;
  return (
    <span className="cb-pp-value" data-part="input-control">
      {first === undefined ? (
        <span className="cb-pp-label" data-part="principal-picker-label" data-placeholder="true">
          <span className="cb-pp-text">{placeholder ?? ""}</span>
        </span>
      ) : (
        <span className="cb-pp-label" data-part="principal-picker-label">
          {option ? avatarOf(option, 16) : null}
          <span className="cb-pp-text">{option?.name ?? first}</span>
        </span>
      )}
      {more > 0 ? (
        <span className="cb-pp-more" data-part="principal-picker-more">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

type ListProps = {
  model: Pick<Model, "groups" | "enabled" | "active" | "setActive" | "choose" | "query">;
  value: string[];
  multiple: boolean;
  loading: boolean;
  /** Ids derive from this (`useId` of the owner). */
  base: string;
  /** The listbox's accessible name. */
  label: string;
};

export function optionDomId(base: string, id: string, ids: string[]): string {
  return `${base}-o${ids.indexOf(id)}`;
}

/** The list: groups and options, the empty line and the loading line. */
function List({ model, value, multiple, loading, base, label }: ListProps) {
  const t = useDesignT();
  const all = model.groups.flatMap((g) => g.items.map((i) => i.id));
  const ref = useRef<HTMLDivElement>(null);
  // the active option stays in view as the arrows move it
  useEffect(() => {
    if (model.active === null) return;
    const el = ref.current?.querySelector(`[data-option-id="${CSS.escape(model.active)}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }, [model.active]);
  const row = (i: Item) => {
    const o = i.option;
    const chosen = value.includes(o.id);
    const id = optionDomId(base, o.id, all);
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the search field owns the keyboard (aria-activedescendant)
      <div
        key={o.id}
        id={id}
        role="option"
        tabIndex={-1}
        className="cb-pp-option"
        data-part="principal-picker-option"
        data-option-id={o.id}
        data-active={model.active === o.id ? "true" : undefined}
        data-hinted={o.hint ? "true" : undefined}
        aria-selected={chosen}
        aria-disabled={o.disabled ? true : undefined}
        aria-describedby={o.hint ? `${id}-hint` : undefined}
        // a press keeps the focus in the search field
        onMouseDown={(e) => e.preventDefault()}
        onMouseMove={() => {
          if (!o.disabled) model.setActive(o.id);
        }}
        onClick={() => model.choose(o.id)}
      >
        {avatarOf(o, 24)}
        <span className="cb-pp-body">
          <span className="cb-pp-name" data-part="principal-picker-name">
            {o.name}
          </span>
          {o.hint ? (
            <span className="cb-pp-hint" id={`${id}-hint`} data-part="principal-picker-hint">
              {o.hint}
            </span>
          ) : null}
        </span>
        {chosen ? <Icon name="check" size={14} /> : null}
      </div>
    );
  };
  const empty = all.length === 0 && !loading;
  return (
    <div className="cb-pp-list" ref={ref}>
      <div
        id={`${base}-list`}
        role="listbox"
        className="cb-pp-options"
        aria-label={label}
        aria-multiselectable={multiple ? true : undefined}
      >
        {model.groups.map((g) =>
          g.label === undefined ? (
            g.items.map(row)
          ) : (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset brings its own border and legend layout
            <div
              key={g.key}
              role="group"
              className="cb-pp-group"
              data-part="principal-picker-group"
              aria-labelledby={`${base}-g-${g.key}`}
            >
              <div
                id={`${base}-g-${g.key}`}
                className="cb-pp-group-label"
                data-part="principal-picker-group-label"
                aria-hidden="true"
              >
                {g.label}
              </div>
              {g.items.map(row)}
            </div>
          ),
        )}
      </div>
      {empty ? (
        <div className="cb-pp-empty" data-part="principal-picker-empty">
          {t("principalPicker.empty")}
        </div>
      ) : null}
      {loading ? (
        <div className="cb-pp-loading" role="status" data-part="principal-picker-loading">
          {t("principalPicker.loading")}
        </div>
      ) : null}
    </div>
  );
}

/** The panel's body: the search field over the list. */
function Panel({ model, value, multiple, loading, base, label }: ListProps & { model: Model }) {
  const t = useDesignT();
  const all = model.groups.flatMap((g) => g.items.map((i) => i.id));
  return (
    <div className="cb-pp-panel" data-part="principal-picker-panel-body">
      <input
        type="search"
        role="combobox"
        className="cb-cmenu-filter cb-pp-search"
        data-part="principal-picker-search"
        aria-label={t("principalPicker.search")}
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-controls={`${base}-list`}
        aria-autocomplete="list"
        {...(model.active !== null
          ? { "aria-activedescendant": optionDomId(base, model.active, all) }
          : {})}
        value={model.query}
        placeholder={t("principalPicker.search")}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => model.setQuery(e.target.value)}
        onKeyDown={model.onKeyDown}
      />
      <List
        model={model}
        value={value}
        multiple={multiple}
        loading={loading}
        base={base}
        label={label}
      />
    </div>
  );
}

/**
 * A combobox that picks people and agents (spec §6.70): a field that opens a search field and a
 * list of options with avatars and hint lines, grouped under 人员 / 智能体 when asked, one choice
 * that closes it or several that keep it open. From 600 up the panel is a `Popover`; on the
 * compact class it is a bottom sheet (a `ClassForms` form: the interaction differs).
 */
export function PrincipalPicker(props: PrincipalPickerProps): JSX.Element {
  const { options, value, multiple = false, placeholder, loading = false, disabled } = props;
  const t = useDesignT();
  const base = useId();
  const wideTrigger = useRef<HTMLButtonElement>(null);
  const compactTrigger = useRef<HTMLButtonElement>(null);
  const model = usePicker(props);
  const label = props["aria-label"] ?? placeholder ?? t("principalPicker.placeholder");

  const field = (ref: RefObject<HTMLButtonElement | null>, id: string, onPress?: () => void) => (
    <button
      ref={ref}
      type="button"
      id={id}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={!disabled && model.open}
      aria-controls={model.open ? `${base}-list` : undefined}
      aria-label={props["aria-label"]}
      disabled={disabled}
      className="cb-select cb-pp-field"
      data-part="principal-picker"
      data-state={disabled ? "disabled" : undefined}
      onClick={onPress}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (model.open) return;
          if (onPress) onPress();
          else model.setOpen(true);
        }
      }}
    >
      <Value options={options} value={value} placeholder={placeholder} />
      <span className="cb-input-affix" aria-hidden="true">
        <Icon name="chevron-down" size={14} />
      </span>
    </button>
  );

  const body = (
    <Panel
      model={model}
      value={value}
      multiple={multiple}
      loading={loading}
      base={base}
      label={label}
    />
  );
  return (
    <div className="cb-pp-root">
      <ClassForms
        wide={
          <Popover
            trigger={field(wideTrigger, `${base}-w`)}
            open={!disabled && model.open}
            onOpenChange={model.setOpen}
            flush
            part="principal-picker-panel"
          >
            {body}
          </Popover>
        }
        compact={
          <>
            {field(compactTrigger, `${base}-c`, () => {
              // focus first: the sheet returns it here on close
              compactTrigger.current?.focus();
              model.setOpen(true);
            })}
            <BottomSheet
              open={!disabled && model.open}
              onOpenChange={model.setOpen}
              title={label}
              part="principal-picker-sheet"
            >
              {body}
            </BottomSheet>
          </>
        }
      />
    </div>
  );
}

export type PrincipalPickerFrameProps = {
  options: PrincipalOption[];
  value: string[];
  multiple?: boolean;
  groups?: boolean;
  loading?: boolean;
  placeholder?: string;
  /** The search text typed so far. */
  query?: string;
  /** The option that is active. */
  activeId?: string;
  /** Draw the field alone, closed. */
  closed?: boolean;
  /** `compact`: the field behind a bottom sheet holding the list. */
  form?: "compact";
  /** The sheet's title (compact). */
  label?: string;
  /** What the compact sheet's page behind it shows. */
  page?: ReactNode;
};

/**
 * The picker drawn in place in one fixed state (the reference blocks and `/dev/ui`): the field
 * and, open, its panel under it; `form="compact"` draws the bottom sheet. The real component is
 * `PrincipalPicker`.
 */
export function PrincipalPickerFrame({
  options,
  value,
  multiple = false,
  groups = false,
  loading = false,
  placeholder,
  query = "",
  activeId,
  closed = false,
  form,
  label,
}: PrincipalPickerFrameProps): JSX.Element {
  const t = useDesignT();
  const base = useId();
  const groupsArranged = arrange(
    options,
    groups,
    { person: t("principalPicker.people"), agent: t("principalPicker.agents") },
    query,
  );
  const enabled = groupsArranged.flatMap((g) =>
    g.items.filter((i) => i.option.disabled !== true).map((i) => i.id),
  );
  const model: Model = {
    open: !closed,
    setOpen: () => {},
    query,
    setQuery: () => {},
    groups: groupsArranged,
    enabled,
    active: activeId ?? enabled[0] ?? null,
    setActive: () => {},
    choose: () => {},
    onKeyDown: () => {},
  };
  const listName = label ?? placeholder ?? t("principalPicker.placeholder");
  const panel = (
    <Panel
      model={model}
      value={value}
      multiple={multiple}
      loading={loading}
      base={base}
      label={listName}
    />
  );
  const fieldNode = (
    <button
      type="button"
      className="cb-select cb-pp-field"
      data-part="principal-picker"
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={!closed}
      aria-label={listName}
    >
      <Value options={options} value={value} placeholder={placeholder} />
      <span className="cb-input-affix" aria-hidden="true">
        <Icon name="chevron-down" size={14} />
      </span>
    </button>
  );
  if (form === "compact") {
    return (
      <BottomSheetFrame
        title={listName}
        state="settling"
        share={0}
        page={<div className="cb-pp-frame-page">{fieldNode}</div>}
      >
        {panel}
      </BottomSheetFrame>
    );
  }
  return (
    <div className="cb-pp-frame">
      {fieldNode}
      {closed ? null : (
        <div
          className="cb-popover cb-pp-frame-panel"
          data-flush="true"
          data-part="principal-picker-panel"
        >
          {panel}
        </div>
      )}
    </div>
  );
}
