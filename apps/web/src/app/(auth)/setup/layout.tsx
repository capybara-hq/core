import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { serverNeedsSetup } from "../../../lib/server-setup";
import { ServerSetupStatusProvider } from "./status";

/** `/setup` is decided on the server: a deployment that is set up goes to sign-in. */
export default async function SetupLayout({ children }: { children: ReactNode }) {
  const needsSetup = await serverNeedsSetup();
  if (needsSetup === false) redirect("/login");
  return <ServerSetupStatusProvider value={needsSetup}>{children}</ServerSetupStatusProvider>;
}
