// Type-only fixture: the hand-written props of @capybara-hq/plugin-client must stay acceptable to
// the design components, and name only props they have (the test runs tsc on this file;
// compat-drift.tsx, compat-required.tsx and compat-extra.tsx are its red twins).
import type {
  ActionRowProps,
  AvatarProps,
  BadgeProps,
  BoardProps,
  ButtonProps,
  CellTitleProps,
  DangerConfirmProps,
  DataTableProps,
  DetailPageProps,
  DialogProps,
  EmptyStateProps,
  FieldProps,
  FilterChipProps,
  FormPageProps,
  FormSectionProps,
  IconProps,
  InputProps,
  ItemListItemProps,
  ItemListProps,
  KbdProps,
  KeyValueProps,
  ListPageProps,
  LogoProps,
  MarkdownProps,
  MenuProps,
  PersonNameProps,
  PopoverProps,
  PrincipalPickerProps,
  PropertySectionProps,
  SegmentedProps,
  SelectProps,
  SettingsPageProps,
  SheetProps,
  SpinnerProps,
  StackProps,
  SwitchProps,
  TabsProps,
  TextProps,
  TextareaProps,
  TooltipProps,
} from "../../../../packages/plugin-client/src/design";
import type {
  ActionRow,
  Avatar,
  Badge,
  Board,
  Button,
  CellTitle,
  DangerConfirm,
  DataTable,
  DetailPage,
  Dialog,
  EmptyState,
  Field,
  FilterChip,
  FormPage,
  FormSection,
  Icon,
  Input,
  ItemList,
  ItemListItem,
  Kbd,
  KeyValue,
  ListPage,
  Logo,
  Markdown,
  Menu,
  PersonName,
  Popover,
  PrincipalPicker,
  PropertySection,
  Segmented,
  Select,
  SettingsPage,
  Sheet,
  Spinner,
  Stack,
  Switch,
  Tabs,
  Text,
  Textarea,
  Tooltip,
} from "../../../../packages/design/src/index";

type DP<C> = C extends (props: infer P) => unknown ? P : never;
/** The package declares icon names as `string`; narrow those fields to the design's. */
type Narrow<T, D> = {
  [K in keyof T]: K extends "name" | "icon" ? (K extends keyof D ? D[K] : T[K]) : T[K];
};
/** A template's `header.path` is optional in the package: the host prepends the scope crumbs. */
type Hosted<P extends { header: { path?: unknown } }> = Omit<P, "header"> & {
  header: P["header"] & { path: NonNullable<P["header"]["path"]> };
};
export const accepts = <A, B>(_ok: [A] extends [B] ? true : false) => {};
/** And the other way: every prop the package declares is a prop of the design component. */
export const known = <A, B>(_ok: [Exclude<keyof A, keyof B>] extends [never] ? true : false) => {};

accepts<Narrow<ActionRowProps, DP<typeof ActionRow>>, DP<typeof ActionRow>>(true);
accepts<Narrow<AvatarProps, DP<typeof Avatar>>, DP<typeof Avatar>>(true);
accepts<Narrow<BadgeProps, DP<typeof Badge>>, DP<typeof Badge>>(true);
accepts<Narrow<BoardProps<{ id: string; columnId: string }>, DP<typeof Board>>, DP<typeof Board>>(true);
accepts<Narrow<ButtonProps, DP<typeof Button>>, DP<typeof Button>>(true);
accepts<Narrow<CellTitleProps, DP<typeof CellTitle>>, DP<typeof CellTitle>>(true);
accepts<Narrow<DangerConfirmProps, DP<typeof DangerConfirm>>, DP<typeof DangerConfirm>>(true);
accepts<Narrow<DataTableProps<unknown>, DP<typeof DataTable>>, DP<typeof DataTable>>(true);
accepts<Narrow<Hosted<DetailPageProps>, DP<typeof DetailPage>>, DP<typeof DetailPage>>(true);
accepts<Narrow<DialogProps, DP<typeof Dialog>>, DP<typeof Dialog>>(true);
accepts<Narrow<EmptyStateProps, DP<typeof EmptyState>>, DP<typeof EmptyState>>(true);
accepts<Narrow<FieldProps, DP<typeof Field>>, DP<typeof Field>>(true);
accepts<Narrow<FilterChipProps, DP<typeof FilterChip>>, DP<typeof FilterChip>>(true);
accepts<Narrow<Hosted<FormPageProps>, DP<typeof FormPage>>, DP<typeof FormPage>>(true);
accepts<Narrow<FormSectionProps, DP<typeof FormSection>>, DP<typeof FormSection>>(true);
accepts<Narrow<IconProps, DP<typeof Icon>>, DP<typeof Icon>>(true);
accepts<Narrow<InputProps, DP<typeof Input>>, DP<typeof Input>>(true);
accepts<Narrow<ItemListProps, DP<typeof ItemList>>, DP<typeof ItemList>>(true);
accepts<Narrow<ItemListItemProps, DP<typeof ItemListItem>>, DP<typeof ItemListItem>>(true);
accepts<Narrow<KbdProps, DP<typeof Kbd>>, DP<typeof Kbd>>(true);
accepts<Narrow<KeyValueProps, DP<typeof KeyValue>>, DP<typeof KeyValue>>(true);
accepts<Narrow<Hosted<ListPageProps>, DP<typeof ListPage>>, DP<typeof ListPage>>(true);
accepts<Narrow<LogoProps, DP<typeof Logo>>, DP<typeof Logo>>(true);
accepts<Narrow<MarkdownProps, DP<typeof Markdown>>, DP<typeof Markdown>>(true);
accepts<Narrow<MenuProps, DP<typeof Menu>>, DP<typeof Menu>>(true);
accepts<Narrow<PersonNameProps, DP<typeof PersonName>>, DP<typeof PersonName>>(true);
accepts<Narrow<PopoverProps, DP<typeof Popover>>, DP<typeof Popover>>(true);
accepts<Narrow<PrincipalPickerProps, DP<typeof PrincipalPicker>>, DP<typeof PrincipalPicker>>(true);
accepts<Narrow<PropertySectionProps, DP<typeof PropertySection>>, DP<typeof PropertySection>>(true);
accepts<Narrow<SegmentedProps, DP<typeof Segmented>>, DP<typeof Segmented>>(true);
accepts<Narrow<SelectProps, DP<typeof Select>>, DP<typeof Select>>(true);
accepts<Narrow<Hosted<SettingsPageProps>, DP<typeof SettingsPage>>, DP<typeof SettingsPage>>(true);
accepts<Narrow<SheetProps, DP<typeof Sheet>>, DP<typeof Sheet>>(true);
accepts<Narrow<SpinnerProps, DP<typeof Spinner>>, DP<typeof Spinner>>(true);
accepts<Narrow<StackProps, DP<typeof Stack>>, DP<typeof Stack>>(true);
accepts<Narrow<SwitchProps, DP<typeof Switch>>, DP<typeof Switch>>(true);
accepts<Narrow<TabsProps, DP<typeof Tabs>>, DP<typeof Tabs>>(true);
accepts<Narrow<TextProps, DP<typeof Text>>, DP<typeof Text>>(true);
accepts<Narrow<TextareaProps, DP<typeof Textarea>>, DP<typeof Textarea>>(true);
accepts<Narrow<TooltipProps, DP<typeof Tooltip>>, DP<typeof Tooltip>>(true);

known<ActionRowProps, DP<typeof ActionRow>>(true);
known<AvatarProps, DP<typeof Avatar>>(true);
known<BadgeProps, DP<typeof Badge>>(true);
known<BoardProps<{ id: string; columnId: string }>, DP<typeof Board>>(true);
known<ButtonProps, DP<typeof Button>>(true);
known<CellTitleProps, DP<typeof CellTitle>>(true);
known<DangerConfirmProps, DP<typeof DangerConfirm>>(true);
known<DataTableProps<unknown>, DP<typeof DataTable>>(true);
known<Hosted<DetailPageProps>, DP<typeof DetailPage>>(true);
known<DialogProps, DP<typeof Dialog>>(true);
known<EmptyStateProps, DP<typeof EmptyState>>(true);
known<FieldProps, DP<typeof Field>>(true);
known<FilterChipProps, DP<typeof FilterChip>>(true);
known<Hosted<FormPageProps>, DP<typeof FormPage>>(true);
known<FormSectionProps, DP<typeof FormSection>>(true);
known<IconProps, DP<typeof Icon>>(true);
known<InputProps, DP<typeof Input>>(true);
known<ItemListProps, DP<typeof ItemList>>(true);
known<ItemListItemProps, DP<typeof ItemListItem>>(true);
known<KbdProps, DP<typeof Kbd>>(true);
known<KeyValueProps, DP<typeof KeyValue>>(true);
known<Hosted<ListPageProps>, DP<typeof ListPage>>(true);
known<LogoProps, DP<typeof Logo>>(true);
known<MarkdownProps, DP<typeof Markdown>>(true);
known<MenuProps, DP<typeof Menu>>(true);
known<PersonNameProps, DP<typeof PersonName>>(true);
known<PopoverProps, DP<typeof Popover>>(true);
known<PrincipalPickerProps, DP<typeof PrincipalPicker>>(true);
known<PropertySectionProps, DP<typeof PropertySection>>(true);
known<SegmentedProps, DP<typeof Segmented>>(true);
known<SelectProps, DP<typeof Select>>(true);
known<Hosted<SettingsPageProps>, DP<typeof SettingsPage>>(true);
known<SheetProps, DP<typeof Sheet>>(true);
known<SpinnerProps, DP<typeof Spinner>>(true);
known<StackProps, DP<typeof Stack>>(true);
known<SwitchProps, DP<typeof Switch>>(true);
known<TabsProps, DP<typeof Tabs>>(true);
known<TextProps, DP<typeof Text>>(true);
known<TextareaProps, DP<typeof Textarea>>(true);
known<TooltipProps, DP<typeof Tooltip>>(true);
