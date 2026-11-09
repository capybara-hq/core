// Type-only fixture: the hand-written props of @capybara-hq/plugin-client must stay acceptable to
// the design components (the test runs tsc on this file; compat-drift.tsx is its red twin).
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
