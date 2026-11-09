import { type ComponentType, createElement, type ReactNode } from "react";

type DesignProps = { children?: ReactNode } & Record<string, unknown>;

declare global {
  // The host sets this before it loads a client entry; in tests, the fake host does.
  var __CAPYBARA_CLIENT_HOST__: { design: Record<string, ComponentType<DesignProps>> } | undefined;
}

function forward(name: string): ComponentType<DesignProps> {
  const Forwarded = (props: DesignProps) => {
    const Target = globalThis.__CAPYBARA_CLIENT_HOST__?.design[name];
    if (!Target) {
      throw new Error(
        `The Capybara client host provides no design component "${name}"; ` +
          "this package only works inside the host or @capybara-hq/plugin-client/testing.",
      );
    }
    return createElement(Target, props);
  };
  Forwarded.displayName = name;
  return Forwarded;
}

export const Button = forward("Button");
export const Badge = forward("Badge");
export const Icon = forward("Icon");
export const KeyValue = forward("KeyValue");
export const Kbd = forward("Kbd");
export const Logo = forward("Logo");
export const Spinner = forward("Spinner");
export const Stack = forward("Stack");
export const Text = forward("Text");
export const Tooltip = forward("Tooltip");
export const PropertySection = forward("PropertySection");
/** The host's renderer of a `UiView`. */
export const ViewBlocks = forward("ViewBlocks");
