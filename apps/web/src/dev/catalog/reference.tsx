"use client";

import { Stack, Text } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { REFERENCE_BLOCKS } from "./reference-blocks";
import type { ReferenceComponent } from "./routes";

/** Each component's blocks (`RefBlock`s with the reference ids); missing ones render a note. */
const BLOCKS: Partial<Record<ReferenceComponent, () => ReactNode>> = REFERENCE_BLOCKS;

/** `/dev/ui/reference/<component>`: every reference block of one component. */
export function ReferenceCatalog({ component }: { component: ReferenceComponent }) {
  const blocks = BLOCKS[component];
  return (
    <Stack gap={24}>
      <Text variant="h1">{`reference/${component}`}</Text>
      {blocks ? (
        <Stack gap={32}>{blocks()}</Stack>
      ) : (
        <Text tone="muted">{`${component}: no blocks yet`}</Text>
      )}
    </Stack>
  );
}
