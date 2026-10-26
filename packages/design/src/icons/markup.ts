import { ICON_NAMES, ICON_NODES, type IconName } from "./paths";

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Each icon's child elements as SVG markup (24 grid), for non-React consumers (the reference set). */
export const ICON_PATHS = Object.fromEntries(
  ICON_NAMES.map((name) => [
    name,
    ICON_NODES[name].map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${attr(v)}"`)
          .join(" ")}/>`,
    ),
  ]),
) as Record<IconName, string[]>;
