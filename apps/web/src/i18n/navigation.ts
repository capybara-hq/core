import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/** 带语言前缀的导航 API（href 不写语言前缀，由当前语言补上）。 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
