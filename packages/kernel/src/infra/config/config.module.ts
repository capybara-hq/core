import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { KernelConfig } from "../../config/schema.js";
import { KERNEL_CONFIG_INPUT } from "../tokens.js";
import { KernelConfigService } from "./kernel-config.service.js";

export interface ConfigModuleOptions {
  /** Environment overrides re-applied on reload; default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Global: `KernelConfigService` for the startup config. Needs `LoggingModule` in the same app. */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class ConfigModule {
  static forRoot(config: KernelConfig, opts: ConfigModuleOptions = {}): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [
        { provide: KERNEL_CONFIG_INPUT, useValue: { config, env: opts.env } },
        KernelConfigService,
      ],
      exports: [KernelConfigService],
    };
  }
}
