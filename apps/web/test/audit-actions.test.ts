import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { AUDIT_ACTION_KEYS } from "../src/lib/audit-actions";

// Every audit action the kernel writes has a label: the action literals in the kernel's sources
// (`action: "x.y"`, passed to its audit writers) are all keys of AUDIT_ACTION_KEYS, and each key
// has its message in both locales. The kernel's org permission names (`OrgAction`, declared with
// `@OrgAction(...)` or listed as `{ action: "agents.create", ... }`) use the same field name and
// are not audit actions.

const KERNEL_SRC = join(import.meta.dirname, "../../../packages/kernel/src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** The kernel's org permission names: the members of `type OrgAction` in orgs/roles.ts. */
function orgActions(): Set<string> {
  const roles = readFileSync(join(KERNEL_SRC, "orgs/roles.ts"), "utf8");
  const union = roles.match(/export type OrgAction =([^;]+);/)?.[1] ?? "";
  return new Set([...union.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string));
}

/** The `action: "x.y"` literals of the kernel's sources (a type union's members included). */
function actionLiterals(): Set<string> {
  const out = new Set<string>();
  for (const file of sources(KERNEL_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\baction: "([a-z_]+(?:\.[a-z_]+)+)"/g)) out.add(m[1] as string);
  }
  return out;
}

type Messages = { admin: { audit: { actions: Record<string, string> } } };

describe("audit action labels", () => {
  it("names every audit action the kernel writes", () => {
    const permissions = orgActions();
    expect(permissions.has("agents.create")).toBe(true);
    const literals = [...actionLiterals()].filter((a) => !permissions.has(a));
    // the scan finds the writers (a broken pattern would pass vacuously)
    expect(literals).toContain("connector.git_push_policy_changed");
    expect(literals.filter((a) => AUDIT_ACTION_KEYS[a] === undefined)).toEqual([]);
  });

  it("every labelled action has its message in both locales", () => {
    for (const messages of [en, zh] as Messages[]) {
      const missing = Object.values(AUDIT_ACTION_KEYS).filter(
        (k) => typeof messages.admin.audit.actions[k] !== "string",
      );
      expect(missing).toEqual([]);
    }
  });
});
