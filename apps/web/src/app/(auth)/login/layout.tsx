import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { serverNeedsSetup } from "../../../lib/server-setup";

/** `/login` on a deployment without an admin goes to the setup wizard before it renders. */
export default async function LoginLayout({ children }: { children: ReactNode }) {
  if ((await serverNeedsSetup()) === true) redirect("/setup");
  return children;
}
