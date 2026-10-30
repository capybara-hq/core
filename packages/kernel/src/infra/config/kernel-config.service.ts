import { Inject, Injectable } from "@nestjs/common";
import { changedPaths, configFields, getPath, secretValues, setPath } from "../../config/fields.js";
import { resolveConfig } from "../../config/load.js";
import { type KernelConfig, KernelConfigSchema } from "../../config/schema.js";
import type { KernelLogger } from "../../log.js";
import { KERNEL_CONFIG_INPUT, KERNEL_LOGGER } from "../tokens.js";

/**
 * Appliers of the hot-reloadable fields: the key is a dotted path marked `hot` in the schema. A
 * hot field without an applier here makes the service refuse to start, so "marked hot but never
 * takes effect" cannot happen.
 */
const HOT_APPLIERS: Record<string, (k: { log: KernelLogger }, value: unknown) => void> = {
  "log.level": (k, v) => k.log.setLevel(String(v)),
  // The runtime reads the concurrency cap through the config service on every quota request.
  "runtime.orgConcurrency": () => {},
  // Eval org concurrency is read the same way at every quota request.
  "evals.orgConcurrency": () => {},
  // Login methods and trusted identity sources are read on every request.
  "auth.loginSources": () => {},
  "auth.trustedIdentitySources": () => {},
  // The hook registry reads the time limit on every run.
  "hooks.timeoutMs": () => {},
  // SandboxService reads the shared-lease cap at every acquisition.
  "sandbox.maxConcurrentCommands": () => {},
  // Sub-agent limits are read at every dispatch, child step and tool resolution.
  "subagents.maxConcurrentPerRun": () => {},
  "subagents.maxDispatchesPerRun": () => {},
  "subagents.maxTokensPerRun": () => {},
};

const HOT_PATHS = configFields(KernelConfigSchema)
  .filter((f) => f.meta?.hot)
  .map((f) => f.path);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface KernelConfigInput {
  /** The validated startup config. */
  config: KernelConfig;
  /** The environment overrides re-applied on every reload (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

export type ConfigChangeListener = (next: KernelConfig, changed: string[]) => void;

/** The current kernel config: `get()` always returns the latest hot-applied value. */
@Injectable()
export class KernelConfigService {
  private current: KernelConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly listeners = new Set<ConfigChangeListener>();

  constructor(
    @Inject(KERNEL_CONFIG_INPUT) input: KernelConfigInput,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {
    for (const p of HOT_PATHS) {
      if (!HOT_APPLIERS[p]) throw new Error(`config field ${p} is marked hot but has no applier`);
    }
    this.current = input.config;
    this.env = input.env ?? process.env;
    log.setLevel(input.config.log.level);
    log.addSecrets(secretValues(KernelConfigSchema, input.config));
  }

  get(): KernelConfig {
    return this.current;
  }

  /** Subscribes to applied changes (hot fields only); returns the unsubscribe function. */
  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Hot reload: re-validates the raw config; only hot fields are applied, other changes warn and
   * list the keys needing a restart; a validation failure keeps the current config.
   */
  apply(raw: unknown): void {
    const log = this.log;
    let next: KernelConfig;
    try {
      next = resolveConfig(raw, this.env);
    } catch (e) {
      log.error("config reload rejected; keeping current config", { error: errMsg(e) });
      return;
    }
    log.addSecrets(secretValues(KernelConfigSchema, next));
    const changed = changedPaths(KernelConfigSchema, this.current, next);
    if (changed.length === 0) return;
    const hot = changed.filter((p) => HOT_PATHS.includes(p));
    const restart = changed.filter((p) => !HOT_PATHS.includes(p));
    const updated = structuredClone(this.current);
    const applied: string[] = [];
    for (const p of hot) {
      try {
        (HOT_APPLIERS[p] as (typeof HOT_APPLIERS)[string])({ log }, getPath(next, p));
        setPath(updated as unknown as Record<string, unknown>, p, getPath(next, p));
        applied.push(p);
      } catch (e) {
        log.error("config reload: cannot apply field; keeping current value", {
          key: p,
          error: errMsg(e),
        });
      }
    }
    this.current = updated;
    if (applied.length > 0) {
      log.info("config reloaded", { applied });
      for (const l of [...this.listeners]) {
        try {
          l(updated, applied);
        } catch (e) {
          log.error("config change listener threw", { error: errMsg(e) });
        }
      }
    }
    if (restart.length > 0) {
      log.warn("config changed but requires restart to take effect", { keys: restart });
    }
  }
}
