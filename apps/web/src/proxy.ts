import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

/**
 * Next 的 Proxy（原 Middleware）：给页面路径补语言前缀、按 Accept-Language 选语言。
 * `/api/*` 不经过这里，由 `app/api/[...path]/route.ts` 原样代理到内核。
 */
const proxy = createMiddleware(routing);
export default proxy;

export const config = {
  // 排除 /api、Next 内部路径与带扩展名的静态文件。
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
