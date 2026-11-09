import { ThemeSwatch, ThemeSwatchGroup } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// ThemeSwatch (spec §6.37): the blocks have the same ids and boxes as
// docs/design/reference/src/theme-swatch.html. The swatch values stand in for a theme's own
// colors with token references, so the catalog holds no color literal.

const noop = () => {};

function themeSwatchBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="theme-swatch-default" width={200} pad>
        <ThemeSwatch
          name="Neon Grid"
          scheme="dark"
          swatches={{
            bg: "var(--cb-bg)",
            panel: "var(--cb-panel)",
            ink: "var(--cb-ink)",
            accent: "var(--cb-accent)",
          }}
          onSelect={noop}
        />
      </RefBlock>
      <RefBlock id="theme-swatch-selected" width={200} pad>
        <ThemeSwatch
          name="Paper"
          scheme="light"
          selected
          swatches={{
            bg: "var(--cb-panel-2)",
            panel: "var(--cb-raised)",
            ink: "var(--cb-muted)",
            accent: "var(--cb-info)",
          }}
          onSelect={noop}
        />
      </RefBlock>
    </>
  );
}

// ThemeSwatchGroup (spec §6.38): docs/design/reference/src/theme-swatch-group.html.
function themeSwatchGroupBlocks(): ReactNode {
  return (
    <RefBlock id="theme-swatch-group-default" width={560} pad>
      <ThemeSwatchGroup
        label="组织默认主题"
        scheme="dark"
        value="neon-grid"
        onChange={noop}
        items={[
          {
            value: "platform",
            name: "跟随平台",
            swatches: {
              dark: {
                bg: "var(--cb-bg)",
                panel: "var(--cb-panel)",
                ink: "var(--cb-ink)",
                accent: "var(--cb-accent)",
              },
            },
          },
          {
            value: "neon-grid",
            name: "霓虹网格",
            swatches: {
              dark: {
                bg: "var(--cb-panel-2)",
                panel: "var(--cb-raised)",
                ink: "var(--cb-muted)",
                accent: "var(--cb-warn)",
              },
            },
          },
          {
            value: "paper",
            name: "纸张",
            swatches: {
              dark: {
                bg: "var(--cb-sidebar)",
                panel: "var(--cb-panel)",
                ink: "var(--cb-ink)",
                accent: "var(--cb-info)",
              },
            },
          },
        ]}
      />
    </RefBlock>
  );
}

export const THEME_SWATCH_BLOCKS = {
  "theme-swatch": themeSwatchBlocks,
  "theme-swatch-group": themeSwatchGroupBlocks,
} as const;
