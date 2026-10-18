import * as RT from "@radix-ui/react-tooltip";
import type { ReactElement, ReactNode } from "react";

export function Tooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  return (
    <RT.Provider delayDuration={400}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content className="cb-tooltip" sideOffset={4}>
            {content}
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
