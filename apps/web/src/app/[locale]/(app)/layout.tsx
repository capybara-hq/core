import type { ReactNode } from "react";
import pkg from "../../../../package.json";
import { AppFrame } from "../../../components/shell/AppFrame";

/** 登录后的页面：App Shell（顶栏 + 状态栏）与会话上下文。URL 不含 `(app)`。 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppFrame version={`v${pkg.version}`}>{children}</AppFrame>;
}
