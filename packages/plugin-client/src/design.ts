import { type ComponentType, createElement, type ReactNode } from "react";
import type { UiView } from "./types.js";

/** Every design name this package forwards to the host (one source for the package and its tests). */
export const DESIGN_NAMES = [
  "Badge",
  "Button",
  "Icon",
  "Kbd",
  "KeyValue",
  "Logo",
  "PropertySection",
  "Select",
  "Spinner",
  "Stack",
  "Text",
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
  density?: "comfortable" | "compact";
  "aria-label"?: string;
  "aria-labelledby"?: string;
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
export const Text = forward<TextProps>("Text");
export const Tooltip = forward<TooltipProps>("Tooltip");
export const PropertySection = forward<PropertySectionProps>("PropertySection");
export const Select = forward<SelectProps>("Select");
/** The host's renderer of a `UiView`. */
export const ViewBlocks = forward<ViewBlocksProps>("ViewBlocks");
