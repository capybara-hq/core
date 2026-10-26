import { createContext, useContext } from "react";

/**
 * The density step of a control (spec §2.5): `dense` inside tables, toolbars, tool rows, inline
 * cards and property sections; `default` everywhere else; `prominent` at most once per view.
 */
export type Density = "dense" | "default" | "prominent";

/** A container sets the step for the controls it holds; an explicit `density` prop wins. */
export const DensityContext = createContext<Density>("default");

export function useDensity(explicit?: Density): Density {
  const inherited = useContext(DensityContext);
  return explicit ?? inherited;
}
