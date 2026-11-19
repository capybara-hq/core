import { type Finding, type Node, type ParsedFile, walk } from "./source.js";

export const SHELL_ACCESS_RULE = "web-shell-access";

const GLOBALS = new Set(["window", "globalThis", "self"]);

const MESSAGE =
  "window.capybaraShell is read only in apps/web/src/lib/shell.ts and packages/design/src/shell/shell-environment.tsx; use the shell helpers (useShell / shell.ts) instead";

/**
 * `web-shell-access`: `window.capybaraShell` (also on `globalThis` / `self`) is read only by
 * `apps/web/src/lib/shell.ts` and `packages/design/src/shell/shell-environment.tsx`; every other
 * file asks those two (spec mobile-layout §9, §11.4). The caller skips the allowed files and tests.
 */
export function shellAccessFindings(p: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const flag = (n: Node) =>
    out.push({
      file: p.file,
      line: p.lineOf(n.start),
      rule: SHELL_ACCESS_RULE,
      message: MESSAGE,
    });
  walk(p.program, (n) => {
    if (n.type === "VariableDeclarator" && (n.id as Node).type === "ObjectPattern") {
      const init = n.init as Node | null;
      if (init?.type !== "Identifier" || !GLOBALS.has(init.name as string)) return;
      for (const prop of (n.id as Node).properties as Node[]) {
        const key = prop.key as Node | undefined;
        if (prop.type === "Property" && key && (key.name ?? key.value) === "capybaraShell")
          flag(prop);
      }
      return;
    }
    if (n.type !== "MemberExpression") return;
    const obj = n.object as Node;
    const prop = n.property as Node;
    const name = n.computed
      ? prop.type === "Literal"
        ? (prop.value as string)
        : undefined
      : (prop.name as string | undefined);
    if (name !== "capybaraShell") return;
    if (obj.type !== "Identifier" || !GLOBALS.has(obj.name as string)) return;
    flag(n);
  });
  return out;
}
