import type { ReactNode } from "react";
import { LocaleSwitcher } from "../../../components/locale-switcher";
import "./globals.css";

/** 旧页面（尚未迁到设计系统模板）的外框：顶部语言切换 + 旧样式。URL 不含 `(legacy)`。 */
export default function LegacyLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <LocaleSwitcher />
      </header>
      <main>{children}</main>
    </>
  );
}
