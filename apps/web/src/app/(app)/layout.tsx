import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import pkg from "../../../package.json";
import { AppFrame } from "../../components/shell/AppFrame";
import { ACCESS_COOKIE, serverNeedsSetup } from "../../lib/server-setup";

/** 登录后的页面：App Shell（顶栏 + 状态栏）与会话上下文。URL 不含 `(app)`。 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // A fresh deployment goes to the setup wizard before anything is painted. Only without the
  // access cookie: with one somebody is signed in, so the deployment is set up.
  if (!(await cookies()).has(ACCESS_COOKIE) && (await serverNeedsSetup()) === true) {
    redirect("/setup");
  }
  return <AppFrame version={`v${pkg.version}`}>{children}</AppFrame>;
}
