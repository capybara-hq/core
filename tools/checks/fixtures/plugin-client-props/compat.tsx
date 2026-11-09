// Type-only fixture: the hand-written props of @capybara-hq/plugin-client must stay acceptable to
// the design components, and name only props they have (the test runs tsc on this file;
// compat-drift.tsx, compat-required.tsx and compat-extra.tsx are its red twins).
import type {
  BadgeProps,
  ButtonProps,
  IconProps,
  KbdProps,
  KeyValueProps,
  LogoProps,
  PropertySectionProps,
  SpinnerProps,
  StackProps,
  TextProps,
  TooltipProps,
} from "../../../../packages/plugin-client/src/design";
import type {
  Badge,
  Button,
  Icon,
  Kbd,
  KeyValue,
  Logo,
  PropertySection,
  Spinner,
  Stack,
  Text,
  Tooltip,
} from "../../../../packages/design/src/index";

type DP<C> = C extends (props: infer P) => unknown ? P : never;
/** The package declares icon names as `string`; narrow those fields to the design's. */
type Narrow<T, D> = {
  [K in keyof T]: K extends "name" | "icon" ? (K extends keyof D ? D[K] : T[K]) : T[K];
};
export const accepts = <A, B>(_ok: [A] extends [B] ? true : false) => {};
/** And the other way: every prop the package declares is a prop of the design component. */
export const known = <A, B>(_ok: [Exclude<keyof A, keyof B>] extends [never] ? true : false) => {};

accepts<Narrow<ButtonProps, DP<typeof Button>>, DP<typeof Button>>(true);
accepts<Narrow<BadgeProps, DP<typeof Badge>>, DP<typeof Badge>>(true);
accepts<Narrow<IconProps, DP<typeof Icon>>, DP<typeof Icon>>(true);
accepts<Narrow<KbdProps, DP<typeof Kbd>>, DP<typeof Kbd>>(true);
accepts<Narrow<KeyValueProps, DP<typeof KeyValue>>, DP<typeof KeyValue>>(true);
accepts<Narrow<LogoProps, DP<typeof Logo>>, DP<typeof Logo>>(true);
accepts<Narrow<PropertySectionProps, DP<typeof PropertySection>>, DP<typeof PropertySection>>(true);
accepts<Narrow<SpinnerProps, DP<typeof Spinner>>, DP<typeof Spinner>>(true);
accepts<Narrow<StackProps, DP<typeof Stack>>, DP<typeof Stack>>(true);
accepts<Narrow<TextProps, DP<typeof Text>>, DP<typeof Text>>(true);
accepts<Narrow<TooltipProps, DP<typeof Tooltip>>, DP<typeof Tooltip>>(true);
known<ButtonProps, DP<typeof Button>>(true);
known<BadgeProps, DP<typeof Badge>>(true);
known<IconProps, DP<typeof Icon>>(true);
known<KbdProps, DP<typeof Kbd>>(true);
known<KeyValueProps, DP<typeof KeyValue>>(true);
known<LogoProps, DP<typeof Logo>>(true);
known<PropertySectionProps, DP<typeof PropertySection>>(true);
known<SpinnerProps, DP<typeof Spinner>>(true);
known<StackProps, DP<typeof Stack>>(true);
known<TextProps, DP<typeof Text>>(true);
known<TooltipProps, DP<typeof Tooltip>>(true);
