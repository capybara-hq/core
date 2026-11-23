import * as RT from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export function Tooltip({
  content,
  open,
  onOpenChange,
  side,
  sideOffset = 4,
  children,
}: {
  content: ReactNode;
  /**
   * Shown regardless of hover and focus (the reference set and the catalog), or, with
   * `onOpenChange`, the controlled open state (a hint a tap opens on a touch screen).
   */
  open?: boolean;
  /** Makes `open` controlled: called when hover, focus, Escape or an outside press change it. */
  onOpenChange?(open: boolean): void;
  side?: "top" | "right" | "bottom" | "left";
  /** Distance from the trigger; default 4. */
  sideOffset?: number;
  children: ReactElement;
}) {
  const state = onOpenChange ? { open: open ?? false, onOpenChange } : open ? { open: true } : {};
  return (
    <RT.Provider delayDuration={400}>
      <RT.Root {...state}>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content className="cb-tooltip" sideOffset={sideOffset} {...(side ? { side } : {})}>
            {content}
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
