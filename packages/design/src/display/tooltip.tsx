import * as RT from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export function Tooltip({
  content,
  open,
  side,
  sideOffset = 4,
  children,
}: {
  content: ReactNode;
  /** Shown regardless of hover and focus (the reference set and the catalog only). */
  open?: boolean;
  side?: "top" | "right" | "bottom" | "left";
  /** Distance from the trigger; default 4. */
  sideOffset?: number;
  children: ReactElement;
}) {
  return (
    <RT.Provider delayDuration={400}>
      <RT.Root {...(open ? { open: true } : {})}>
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
