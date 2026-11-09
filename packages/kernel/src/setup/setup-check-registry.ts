import type {
  SetupCheckResult,
  SetupCheckStatus,
  SetupCheckText,
  SetupGuidePlace,
} from "@capybara-hq/plugin-sdk";
import { SETUP_CHECK_ID_RE, SETUP_GUIDE_PLACES } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { RegisteredSetupCheck } from "../ctx/create-ctx.js";
import type { InflightTracker } from "../extensions/inflight.js";
import { ExtensionRegistry } from "../extensions/registry.js";

/**
 * The state of one check row (spec §10.3): a result, `running` (another request runs it, or the
 * org's concurrency cap is reached) or `not_run`. The fields are fixed: nothing else ever leaves
 * the kernel, in particular no extension error text.
 */
export interface SetupCheckState {
  status: SetupCheckStatus | "running" | "not_run";
  reason?: SetupCheckText;
  fix?: SetupCheckText;
  /** ISO time of the result. */
  checkedAt?: string;
  /** A forced rerun is refused until then. */
  cooldownUntil?: string;
}

/** The object a kernel check is about: ids and the plugin, never a config or a credential. */
export type KernelCheckTarget =
  | { kind: "channel-connection"; connectionId: string; plugin: string }
  | { kind: "connector"; connectorId: string; templateId: string; plugin: string };

/** What a kernel check (`capybara:*`) receives. */
export interface KernelCheckArgs {
  orgId: string;
  /** The caller (person or the agent's trigger account). */
  accountId: string;
  mode: string | null;
  target: KernelCheckTarget;
  /** Aborted at the kernel's timeout. */
  signal: AbortSignal;
  /**
   * Every secret value the kernel redacts the result by: the target's (a connection's secret
   * fields, a connector's stored credentials) and the plugin's deployment and org config secrets.
   */
  secrets: string[];
}

/** A kernel check's implementation. */
export type KernelCheckRun = (args: KernelCheckArgs) => Promise<SetupCheckResult>;

/** A check found for a guide's `::check` line. */
export type ResolvedSetupCheck =
  | { source: "kernel"; id: string; place: SetupGuidePlace | "any"; run: KernelCheckRun }
  | {
      source: "plugin";
      id: string;
      place: SetupGuidePlace;
      run: RegisteredSetupCheck["run"];
      inflight: InflightTracker;
      /** The instance's `ctx.signal` (aborted when the instance is revoked). */
      signal: AbortSignal;
      version: string;
      generation: number;
    };

const KERNEL_ID_RE = new RegExp(`^capybara:${SETUP_CHECK_ID_RE.source.slice(1)}`);

/**
 * Where setup checks come from (spec §10.2, §10.6): the kernel's own `capybara:*` checks, in a
 * map of their own registered once at module init (static code, the same on every replica, like
 * the builtin tools), and an extension's checks, read from its active instance on this replica
 * (registered in its `setup` through `ctx.setup.check`, revoked with the instance). An extension
 * can never register a `capybara:` id (`SETUP_CHECK_ID_RE` has no colon), so it cannot shadow a
 * kernel check.
 */
@Injectable()
export class SetupCheckRegistry {
  private readonly kernel = new Map<
    string,
    Readonly<{ place: SetupGuidePlace | "any"; run: KernelCheckRun }>
  >();

  constructor(
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "current">,
  ) {}

  /** Registers a kernel check; an id twice, a malformed id or an unknown place throws. */
  registerKernel(id: `capybara:${string}`, place: SetupGuidePlace | "any", run: KernelCheckRun) {
    if (!KERNEL_ID_RE.test(id)) throw new Error(`setup check id "${id}" is not capybara:<id>`);
    if (place !== "any" && !(SETUP_GUIDE_PLACES as readonly string[]).includes(place)) {
      throw new Error(`setup check "${id}": unknown place "${place}"`);
    }
    if (typeof run !== "function") throw new Error(`setup check "${id}": run must be a function`);
    if (this.kernel.has(id)) throw new Error(`duplicate kernel setup check "${id}"`);
    this.kernel.set(id, Object.freeze({ place, run }));
  }

  /**
   * The check behind a guide's `::check <id>` line of `plugin`'s guide: a kernel check for
   * `capybara:*`, else the plugin's own (null when this replica does not run the extension or the
   * extension did not register the id).
   */
  resolve(plugin: string, id: string): ResolvedSetupCheck | null {
    if (id.startsWith("capybara:")) {
      const k = this.kernel.get(id);
      return k ? { source: "kernel", id, place: k.place, run: k.run } : null;
    }
    const inst = this.extensions.current(plugin);
    const c = inst?.setupChecks.get(id);
    if (!inst || !c) return null;
    return {
      source: "plugin",
      id,
      place: c.place,
      run: c.run,
      inflight: inst.inflight,
      signal: inst.signal,
      version: inst.version,
      generation: inst.generation,
    };
  }

  /** Whether `plugin` runs on this replica. */
  running(plugin: string): boolean {
    return this.extensions.current(plugin) !== undefined;
  }
}
