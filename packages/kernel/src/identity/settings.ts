import { z } from "zod";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "./audit.js";

export const DEPLOYMENT_SETTINGS = z.object({
  orgCreation: z.enum(["anyone", "enterprise_admin"]).default("anyone"),
});
export type DeploymentSettings = z.infer<typeof DEPLOYMENT_SETTINGS>;

/** 部署级设置：每个键一行，读时缺省用默认值。 */
export class SettingsService {
  constructor(private readonly db: KernelDb) {}

  async get(): Promise<DeploymentSettings> {
    const rows = await this.db.selectFrom("deployment_settings").select(["key", "value"]).execute();
    const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const parsed = DEPLOYMENT_SETTINGS.safeParse(raw);
    return parsed.success ? parsed.data : DEPLOYMENT_SETTINGS.parse({});
  }

  async update(
    patch: Partial<DeploymentSettings>,
    actorAccountId: string,
  ): Promise<DeploymentSettings> {
    const check = DEPLOYMENT_SETTINGS.partial().safeParse(patch);
    if (!check.success) {
      throw new ApiError(
        "validation_failed",
        "Invalid deployment settings",
        check.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    await this.db.transaction().execute(async (trx) => {
      for (const [key, value] of Object.entries(check.data)) {
        if (value === undefined) continue;
        const json = JSON.stringify(value);
        await trx
          .insertInto("deployment_settings")
          .values({ key, value: json, updated_by: actorAccountId })
          .onConflict((oc) =>
            oc
              .column("key")
              .doUpdateSet({ value: json, updated_by: actorAccountId, updated_at: new Date() }),
          )
          .execute();
      }
      await audit(trx, {
        actorAccountId,
        action: "deployment.settings.updated",
        detail: check.data,
      });
    });
    return this.get();
  }
}
