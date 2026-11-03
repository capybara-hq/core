import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { ExtensionHost } from "./host.js";

/**
 * Extension display names (extension config forms spec §2.2), the one resolver every extension and
 * model API uses: a config-declared extension's plugin.json (read by this replica's host at load,
 * the same on every replica), else the installed package's `display_name`, else the live catalog
 * item of the same name, else null. No backfill: a package stored before 0065 gets a name with its
 * next version. Stateless; one query per call.
 */
@Injectable()
export class ExtensionDisplayNames {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    /** The config-declared extensions (they win over an install record of the same name, C15). */
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
  ) {}

  /** One extension's display name. */
  async get(name: string): Promise<LocalizedName | null> {
    return (await this.many([name])).get(name) ?? null;
  }

  /** The display names of `names` (each one a key, null when it has none), in one query. */
  async many(names: string[]): Promise<Map<string, LocalizedName | null>> {
    const out = new Map<string, LocalizedName | null>();
    if (names.length === 0) return out;
    const declared = new Map(this.host.declaredPlugins().map((p) => [p.name, p]));
    const rest: string[] = [];
    for (const n of new Set(names)) {
      const d = declared.get(n);
      if (d) out.set(n, d.displayName);
      else rest.push(n);
    }
    if (rest.length === 0) return out;
    const rows = await this.db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select([
        "extension_installs.name as name",
        "extension_packages.display_name as display_name",
        sql<number>`0`.as("rank"),
      ])
      .where("extension_installs.name", "in", rest)
      .unionAll((eb) =>
        eb
          .selectFrom("catalog_items")
          .select(["name", "display_name", sql<number>`1`.as("rank")])
          .where("name", "in", rest)
          .where("deleted_at", "is", null),
      )
      .execute();
    rows.sort((a, b) => Number(a.rank) - Number(b.rank));
    for (const n of rest) {
      out.set(n, rows.find((r) => r.name === n && r.display_name !== null)?.display_name ?? null);
    }
    return out;
  }
}
