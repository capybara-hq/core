"use client";

import { createContext, type ReactNode } from "react";

/** What the setup layout learned on the server (`undefined`: the kernel didn't answer). */
export const ServerSetupStatus = createContext<boolean | undefined>(undefined);

export function ServerSetupStatusProvider({
  value,
  children,
}: {
  value: boolean | undefined;
  children: ReactNode;
}) {
  return <ServerSetupStatus.Provider value={value}>{children}</ServerSetupStatus.Provider>;
}
