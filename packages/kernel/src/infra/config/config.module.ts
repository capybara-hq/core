import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { KernelConfig } from "../../config/schema.js";
import { createKeyring } from "../../ctx/secrets.js";
import { KERNEL_CONFIG_INPUT, KEYRING } from "../tokens.js";
import { KernelConfigService } from "./kernel-config.service.js";

export interface ConfigModuleOptions {
  /** Environment overrides re-applied on reload; default `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Global: `KernelConfigService` for the startup config and the master `KEYRING`. Needs
 * `LoggingModule` in the same app.
 */
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
        {
          // the master key is not hot: the keyring of the startup config
          provide: KEYRING,
          useFactory: () =>
            createKeyring(
              Buffer.from(config.masterKey, "base64"),
              config.masterKeyPrevious.map((k) => Buffer.from(k, "base64")),
            ),
        },
      ],
      exports: [KernelConfigService, KEYRING],
    };
  }
}
