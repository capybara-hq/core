/**
 * 嵌入应用的同源代理 `/plugin-ui/<plugin>/<rest>` → 内核 `/plugins/<plugin>/ui/<rest>`。
 * 规则（只放行 GET / POST 与预检、路径限定在插件的 `/ui/` 下、不转发 Cookie、去掉 Set-Cookie、CSP 等安全头、
 * 流式透传）见 `lib/plugin-ui-proxy.ts`。
 */

import { preflightPluginUi, proxyPluginUi } from "../../../lib/plugin-ui-proxy";

export const dynamic = "force-dynamic";

export const GET = proxyPluginUi;
export const POST = proxyPluginUi;
export const OPTIONS = preflightPluginUi;
