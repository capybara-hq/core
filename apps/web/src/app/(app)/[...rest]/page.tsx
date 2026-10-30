import { notFound } from "next/navigation";

/**
 * (app) 内未匹配的路径：抛出 notFound()，由 `(app)/not-found.tsx` 在 App Shell 内渲染 404
 * （HTTP 状态保持 404）。不渲染任何 JSX，因此豁免页面模板规则。
 */
export default function CatchAllPage(): never {
  notFound();
}
