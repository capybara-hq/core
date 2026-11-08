import { ThemeSwatch } from "@capybara-hq/design";
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
          name="Night City"
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

export const THEME_SWATCH_BLOCKS = { "theme-swatch": themeSwatchBlocks } as const;
