import { describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../src/config/schema.js";
import { ExtensionHost } from "../src/extensions/host.js";
import { KernelModule } from "../src/kernel.module.js";
import { createLogger } from "../src/log.js";
import type { KernelOverride } from "../src/overrides.js";
import { RUN_HOOKS } from "../src/runtime/run-worker.js";

const config = KernelConfigSchema.parse({
  db: { url: "postgres://u:p@127.0.0.1:1/db" },
  redis: { url: "redis://127.0.0.1:1" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const logger = createLogger("error", { write: () => {} });

describe("KernelAppOptions.overrides", () => {
  it("accepts a named test seam", () => {
    const overrides: KernelOverride[] = [{ provide: RUN_HOOKS, useValue: {} }];
    expect(() => KernelModule.forRoot(config, { logger, overrides })).not.toThrow();
  });

  it("refuses any other token: a domain class cannot be replaced this way", () => {
    const overrides = [{ provide: ExtensionHost, useValue: {} }] as unknown as KernelOverride[];
    expect(() => KernelModule.forRoot(config, { logger, overrides })).toThrow(
      "overrides: ExtensionHost is not a kernel test seam",
    );
  });
});
