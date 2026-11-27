import { type ComponentType, createElement, type ReactNode } from "react";
import type { UiView } from "./types.js";

/** Every design name this package forwards to the host (one source for the package and its tests). */
export const DESIGN_NAMES = [
  "ActionRow",
  "Avatar",
  "Badge",
  "Board",
  "Button",
  "CellTitle",
  "DangerConfirm",
  "DataTable",
  "DetailPage",
  "Dialog",
  "EmptyState",
  "Field",
  "FilterChip",
  "FormPage",
  "FormSection",
  "Icon",
  "Input",
  "ItemList",
  "ItemListItem",
  "Kbd",
  "KeyValue",
  "ListPage",
  "Logo",
  "Markdown",
  "Menu",
  "PersonName",
  "Popover",
  "PrincipalPicker",
  "PropertySection",
  "Segmented",
  "Select",
  "SettingsPage",
  "Sheet",
  "Spinner",
  "Stack",
  "Switch",
  "Tabs",
  "Text",
  "Textarea",
  "Tooltip",
  "ViewBlocks",
] as const;

type HostDesign = Record<string, ComponentType<never>>;
interface ClientHostGlobal {
  design: HostDesign;
}
const HOST_KEY = "__CAPYBARA_CLIENT_HOST__";

/** The host's design components (the host sets the global before it loads a client entry). */
export function clientHost(): ClientHostGlobal | undefined {
  return (globalThis as unknown as Record<string, ClientHostGlobal | undefined>)[HOST_KEY];
}

export function setClientHost(host: ClientHostGlobal | undefined): void {
  (globalThis as unknown as Record<string, ClientHostGlobal | undefined>)[HOST_KEY] = host;
}

// The props below are hand-written minimal copies of the design system's (frozen per
// CLIENT_API_VERSION); tools/checks tests prove each is compatible with the design component.
export interface ButtonProps {
  variant?: "primary" | "secondary" | "default" | "ghost" | "danger" | "danger-solid";
  loading?: boolean;
  shortcut?: string;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  title?: string;
  "aria-label"?: string;
  onClick?: () => void;
  children?: ReactNode;
}
export interface BadgeProps {
  tone?: "default" | "accent" | "warn" | "count";
  children?: ReactNode;
}
export interface IconProps {
  name: string;
  size?: 16 | 14 | 12;
  label?: string;
}
export interface KeyValueProps {
  rows: { k: ReactNode; v: ReactNode }[];
  keyWidth?: `${number}ch`;
  columns?: 1 | 2;
}
export interface KbdProps {
  children?: ReactNode;
}
export interface LogoProps {
  scale?: 2 | 3 | 6;
  tone?: "accent" | "muted";
  wordmark?: boolean;
}
export interface SpinnerProps {
  label?: string;
  size?: 12 | 16;
}
export interface StackProps {
  gap?: 0 | 4 | 8 | 12 | 16 | 24 | 32;
  direction?: "column" | "row";
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  justify?: "start" | "center" | "end" | "between";
  wrap?: boolean;
  children?: ReactNode;
}
export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The switch's accessible name (a switch draws no text of its own). */
  label: string;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
}
export interface TextProps {
  variant?: "h1" | "h2" | "h3" | "body" | "small" | "micro" | "prose";
  tone?: "ink" | "muted" | "faint" | "accent" | "ok" | "fail" | "warn";
  truncate?: boolean;
  pre?: boolean;
  icon?: string;
  title?: string;
  children?: ReactNode;
}
export interface TooltipProps {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  sideOffset?: number;
  children: React.ReactElement;
}
export interface PropertySectionProps {
  title: string;
  value?: ReactNode;
  valueTone?: "ink" | "muted";
  state?: "loading" | "ready" | "failed";
  failure?: { reason?: string };
  onRetry?(): void;
  children?: ReactNode;
}
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectProps {
  options: SelectOption[];
  value?: string;
  /** The chosen value, as a native select's change event carries it (`.target.value`). */
  onChange?: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  /** Shown while the value matches no option. */
  placeholder?: string;
  density?: "dense" | "default" | "prominent";
  "aria-label"?: string;
  "aria-labelledby"?: string;
}
/** One item of a {@link MenuProps} menu (a page header's `menu` action too). */
export type MenuItem =
  | ({
      label: string;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      description?: string;
    } & (
      | { onSelect(): void; href?: undefined; submenu?: undefined }
      | { href: string; onSelect?(): void; submenu?: undefined }
      | { submenu: MenuItem[]; onSelect?: undefined; href?: undefined }
    ))
  | "separator";
export interface MenuProps {
  trigger: React.ReactElement<Record<string, unknown>>;
  items: MenuItem[];
  side?: "bottom" | "right";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The menu's accessible name. */
  label?: string;
}
export interface PopoverProps {
  trigger: React.ReactElement<Record<string, unknown>>;
  children: ReactNode;
  active?: boolean;
  flush?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

// ---- page templates (the host prepends the scope crumbs to `header.path`) ----

type HeaderButton = {
  label: string;
  variant: "primary" | "secondary" | "default";
  shortcut?: string;
  loading?: boolean;
  disabled?: boolean;
};
/** A header button (`onSelect`) or link (`href`), or a menu of more actions. */
export type PageAction =
  | (HeaderButton & { onSelect?(): void; href?: undefined })
  | (HeaderButton & { href: string; onSelect?: undefined })
  | { menu: MenuItem[]; label: string };
/**
 * A page's head. `path` is what comes after the host's own crumbs (the org and this page's
 * name); a segment with `href` is a link, the last one is the current place.
 */
export interface PageHeader {
  path?: { label: string; href?: string }[];
  title: string;
  description?: string;
  count?: ReactNode;
  status?: ReactNode;
  actions?: PageAction[];
  tabs?: {
    id: string;
    label: string;
    count?: number;
    href?: string;
    onSelect?(): void;
  }[];
  activeTab?: string;
  search?: { label: string; value: string; onChange(v: string): void };
}
export interface ActionRowProps {
  unsaved?: number;
  errors?: number;
  cancel?: { label: string; onSelect(): void; disabled?: boolean };
  secondary?: ActionButton;
  primary: ActionButton;
}
interface ActionButton {
  label: string;
  onSelect(): void;
  shortcut?: string;
  loading?: boolean;
  disabled?: boolean;
}
export interface EmptyStateProps {
  text: string;
  hint?: string;
  action?:
    | (HeaderButton & { onSelect?(): void; href?: undefined })
    | (HeaderButton & { href: string; onSelect?: undefined });
  size?: "page" | "panel" | "compact";
}
export interface ListMoreProps {
  onLoadMore?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  loadingMore?: boolean | undefined;
  loadMoreError?: string | null | undefined;
}
export interface ListPageProps {
  header: PageHeader;
  actionRow?: ActionRowProps;
  variant?: "objects" | "records" | "cards";
  listLabel?: string;
  empty?: EmptyStateProps;
  loading?: boolean;
  filters?: ReactNode;
  filterCount?: number;
  more?: ListMoreProps;
  children?: ReactNode;
}
export interface TabsProps {
  items: {
    id: string;
    label: string;
    count?: number | string;
    badge?: string;
    alert?: boolean;
    disabled?: boolean;
    href?: string;
  }[];
  value: string;
  onChange?: (id: string) => void;
  label: string;
  look?: "underline" | "segmented-compact";
}
export interface DetailPageProps {
  header: PageHeader;
  tabs?: TabsProps | undefined;
  facts?: ReactNode;
  loading?: { facts?: boolean; blocks?: number };
  children?: ReactNode;
}
export interface FormPageProps {
  header: PageHeader;
  actionRow: ActionRowProps;
  create?: boolean;
  loading?: boolean;
  children?: ReactNode;
}
export interface FormSectionProps {
  id: string;
  title: string;
  marks?: ReactNode;
  description?: string;
  layout?: "stacked";
  flush?: boolean;
  loading?: { fields: number };
  children?: ReactNode;
}
export interface SettingsPageProps {
  header: PageHeader;
  nav: {
    group: string;
    items: { id: string; label: string; href: string; count?: number }[];
  }[];
  activeNav: string;
  actionRow?: ActionRowProps;
  children?: ReactNode;
}

// ---- data display ----

export interface DataTableColumn<T> {
  key: string;
  header: string;
  cell(row: T): ReactNode;
  align?: "left" | "right";
  tone?: "ink" | "muted";
  sortable?: boolean;
  width?: number;
  wrap?: boolean;
  fit?: boolean;
  interactive?: boolean;
  compact?: "title" | "subtitle" | "meta" | "trailing" | "hidden";
}
export interface DataTableProps<T> extends ListMoreProps {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey(row: T): string;
  /** The table's accessible name. */
  label: string;
  state?: "ready" | "loading" | "error";
  error?: { code: string; requestId?: string; onRetry(): void };
  empty?: { title: string; hint?: string; action?: ReactNode };
  noResults?: { description: string; onClear(): void };
  toolbar?: ReactNode;
  toolbarEnd?: ReactNode;
  activeKey?: string;
  onOpen?(row: T): void;
  rowMenu?(row: T): MenuItem[];
  isDisabled?(row: T): boolean;
  rowLabel?(row: T): string;
  sort?: { key: string; dir: "asc" | "desc"; onChange(key: string, dir: "asc" | "desc"): void };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    pageSizes?: number[];
    onPage: (p: number) => void;
    onPageSize?: (s: number) => void;
  };
  rowHeight?: "dense" | "default" | "roomy";
  framed?: boolean;
}
export interface CellTitleProps {
  title: string;
  description?: string;
  trailing?: string;
  mono?: boolean;
  initial?: string;
}
export interface ItemListRow {
  id: string;
  tag?: { label: string; tone?: "default" | "accent" };
  title: string;
  meta?: string;
  status?: { label: string; tone?: "default" | "accent" };
  href?: string;
  actions?: ReactNode;
}
export interface ItemListProps extends ListMoreProps {
  label: string;
  rows?: ItemListRow[];
  children?: ReactNode;
  empty?: string | Omit<EmptyStateProps, "size">;
  inset?: "card" | "flush";
}
export interface ItemListItemProps {
  title: string;
  code?: string;
  marks?: ReactNode;
  tag?: { label: string; tone?: "default" | "accent" };
  href?: string;
  actions?: ReactNode;
  meta?: ReactNode;
  invalid?: boolean;
  children?: ReactNode;
}
export interface MarkdownProps {
  text: string;
}
export interface AvatarProps {
  /** An image route, or `null` for the name's initial. */
  value: { kind: "image"; src: string } | null;
  name: string;
  size: 16 | 24 | 28 | 40 | 64;
  shape?: "square" | "circle";
}
export interface PersonNameProps {
  name: string;
  avatarUrl: string | null;
  size: 16 | 24;
  secondary?: string;
}
export interface FilterChipProps {
  label: string;
  count?: number | string;
  selected: boolean;
  onSelect: () => void;
  density?: "dense" | "default" | "prominent";
}

// ---- inputs ----

export interface InputProps {
  value?: string;
  placeholder?: string;
  /** The text, as a native input's change event carries it (`.target.value`). */
  onChange?: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  invalid?: boolean;
  type?: "text" | "email" | "url" | "number" | "search" | "password" | "date" | "time";
  name?: string;
  id?: string;
  maxLength?: number;
  autoFocus?: boolean;
  readOnly?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
  density?: "dense" | "default" | "prominent";
  prefix?: ReactNode;
  suffix?: ReactNode;
}
export interface TextareaProps {
  value?: string;
  placeholder?: string;
  onChange?: (e: { target: { value: string } }) => void;
  disabled?: boolean;
  rows?: number;
  maxLength?: number;
  readOnly?: boolean;
  id?: string;
  name?: string;
  code?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
}
export interface FieldProps {
  label: string;
  required?: boolean;
  optional?: boolean;
  help?: string;
  error?: string;
  count?: { value: number; max: number };
  onReset?: () => void;
  action?: ReactNode;
  children: React.ReactElement<Record<string, unknown>>;
}
export interface SegmentedProps {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  label: string;
  density?: "dense" | "default" | "prominent";
  fill?: boolean;
}
export interface PrincipalOption {
  kind: "person" | "agent";
  id: string;
  name: string;
  avatar?: { kind: "image"; src: string } | null;
  hint?: string;
  disabled?: boolean;
}
export interface PrincipalPickerProps {
  options: PrincipalOption[];
  /** The chosen ids. */
  value: string[];
  onChange(ids: string[]): void;
  multiple?: boolean;
  placeholder?: string;
  groups?: boolean;
  onSearch?(query: string): void;
  loading?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
}

// ---- overlays ----

export interface DialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  size?: 480 | 640 | 760 | 1060;
  footer: ReactNode;
  initialFocus?: "primary" | "cancel" | undefined;
  danger?: boolean;
  children?: ReactNode;
}
export interface DangerConfirmProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  /** The name the person types to confirm. */
  confirmName: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onConfirm(): void | Promise<void>;
}
export interface SheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  meta?: ReactNode;
  width?: 480 | 720;
  tabs?: ReactNode;
  footer?: ReactNode;
  dirty?: boolean;
  children?: ReactNode;
}

// ---- board ----

export interface BoardColumn {
  id: string;
  title: string;
  count?: number;
  locked?: boolean;
  hint?: string;
}
export interface BoardCard {
  id: string;
  columnId: string;
}
export interface BoardProps<C extends BoardCard> {
  columns: BoardColumn[];
  cards: C[];
  /** The card's content: no buttons or links of its own (the card is the button). */
  renderCard(card: C): ReactNode;
  /** `index` in the target column without the moved card. A rejected promise snaps the card back. */
  onMove(cardId: string, toColumnId: string, index: number): void | Promise<void>;
  canMove?(card: C, toColumnId: string): boolean;
  onOpen?(cardId: string): void;
  empty?: ReactNode;
  loading?: boolean;
}
export interface ViewBlocksProps {
  view: UiView;
}

function forward<P>(name: string): ComponentType<P> {
  const Forwarded = (props: P) => {
    const Target = clientHost()?.design[name] as ComponentType<P> | undefined;
    if (!Target) {
      throw new Error(
        `The Capybara client host provides no design component "${name}"; ` +
          "this package only works inside the host or @capybara-hq/plugin-client/testing.",
      );
    }
    return createElement(Target as ComponentType<object>, props as object);
  };
  Forwarded.displayName = name;
  return Forwarded;
}

export const Button = forward<ButtonProps>("Button");
export const Badge = forward<BadgeProps>("Badge");
export const Icon = forward<IconProps>("Icon");
export const KeyValue = forward<KeyValueProps>("KeyValue");
export const Kbd = forward<KbdProps>("Kbd");
export const Logo = forward<LogoProps>("Logo");
export const Spinner = forward<SpinnerProps>("Spinner");
export const Stack = forward<StackProps>("Stack");
export const Switch = forward<SwitchProps>("Switch");
export const Text = forward<TextProps>("Text");
export const Tooltip = forward<TooltipProps>("Tooltip");
export const PropertySection = forward<PropertySectionProps>("PropertySection");
export const Select = forward<SelectProps>("Select");
export const ActionRow = forward<ActionRowProps>("ActionRow");
export const Avatar = forward<AvatarProps>("Avatar");
export const Board = forward<BoardProps<never>>("Board") as <C extends BoardCard>(
  props: BoardProps<C>,
) => React.ReactElement | null;
export const CellTitle = forward<CellTitleProps>("CellTitle");
export const DangerConfirm = forward<DangerConfirmProps>("DangerConfirm");
export const DataTable = forward<DataTableProps<never>>("DataTable") as <T>(
  props: DataTableProps<T>,
) => React.ReactElement | null;
export const DetailPage = forward<DetailPageProps>("DetailPage");
export const Dialog = forward<DialogProps>("Dialog");
export const EmptyState = forward<EmptyStateProps>("EmptyState");
export const Field = forward<FieldProps>("Field");
export const FilterChip = forward<FilterChipProps>("FilterChip");
export const FormPage = forward<FormPageProps>("FormPage");
export const FormSection = forward<FormSectionProps>("FormSection");
export const Input = forward<InputProps>("Input");
export const ItemList = forward<ItemListProps>("ItemList");
export const ItemListItem = forward<ItemListItemProps>("ItemListItem");
export const ListPage = forward<ListPageProps>("ListPage");
export const Markdown = forward<MarkdownProps>("Markdown");
export const Menu = forward<MenuProps>("Menu");
export const PersonName = forward<PersonNameProps>("PersonName");
export const Popover = forward<PopoverProps>("Popover");
export const PrincipalPicker = forward<PrincipalPickerProps>("PrincipalPicker");
export const Segmented = forward<SegmentedProps>("Segmented");
export const SettingsPage = forward<SettingsPageProps>("SettingsPage");
export const Sheet = forward<SheetProps>("Sheet");
export const Tabs = forward<TabsProps>("Tabs");
export const Textarea = forward<TextareaProps>("Textarea");
/** The host's renderer of a `UiView`. */
export const ViewBlocks = forward<ViewBlocksProps>("ViewBlocks");
