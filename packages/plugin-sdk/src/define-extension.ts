import semver from "semver";
import type { z } from "zod";
import type { ExtensionContext } from "./ctx.js";
import {
  EXTENSION_POINTS,
  type ExtensionPointRef,
  parseExtensionPoint,
} from "./extension-point.js";
import {
  type ExtensionPermissions,
  validatePermissions,
  validateUiContributions,
} from "./permissions.js";
import type { UiContribution } from "./ui.js";

/** The plugin manifest. */
export interface ExtensionManifest {
  name: string;
  version: string;
  sdk: string;
  provides: ExtensionPointRef[];
  requires?: ExtensionPointRef[];
  /**
   * Optional dependencies: when missing the plugin still loads, and decides at runtime through
   * ctx.extensionPoints.
   */
  optional?: ExtensionPointRef[];
  /** Permission manifest (governance, not a sandbox). */
  permissions?: ExtensionPermissions;
  /**
   * UI contributions, each in a slot of `UI_SLOTS`; every id is also listed in `permissions.ui`.
   * Kept exactly as written: structural problems fail the extension, while a contribution to an
   * unknown slot or version is only dropped when the host resolves the slots (`resolveUiSlots`).
   */
  ui?: UiContribution[];
  config?: { deployment?: z.ZodTypeAny; org?: z.ZodTypeAny };
  migrations?: string;
  setup(ctx: ExtensionContext): void | Promise<void>;
  /**
   * Optional: called when the plugin instance is revoked (disabled, uninstalled, replaced by a new
   * instance on upgrade, a dependent reloaded together with its provider).
   * By then the kernel has already: stopped accepting new calls, waited for in-flight calls to
   * finish (at most `extensionHost.drainSeconds`), aborted `ctx.signal`,
   * and revoked every registration this instance made through ctx (tools, routes, queue workers,
   * bus subscriptions, lock leases, UI, provide).
   * Clean up here only what the plugin opened outside ctx (e.g. its own connections); do not
   * register anything through ctx again.
   * Not called when setup throws (the kernel revokes what was already registered).
   */
  dispose?(ctx: ExtensionContext): void | Promise<void>;
}

/** The plugin manifest is invalid. */
export class ExtensionManifestError extends Error {
  constructor(plugin: string, message: string) {
    super(`extension ${plugin}: ${message}`);
    this.name = "ExtensionManifestError";
  }
}

/** Plugin name rule (manifest `name`; a connector template's `plugin` is validated by it too). */
export const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const NAME_RE = EXTENSION_NAME_RE;

/**
 * Reserved plugin name: the kernel uses `kernel` as its own secrets namespace, so a plugin cannot
 * take it.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["kernel"]);

function checkRefs(
  label: string,
  refs: readonly string[],
  fail: (m: string) => never,
  forbidBrokered = false,
): void {
  for (const ref of refs) {
    let name: string;
    try {
      name = parseExtensionPoint(ref).name;
    } catch {
      fail(`${label} entry "${ref}" is not a valid extension point ref`);
    }
    if (!Object.hasOwn(EXTENSION_POINTS, name)) {
      fail(`${label} entry "${ref}" references unregistered extension point "${name}"`);
    }
    if (forbidBrokered && EXTENSION_POINTS[name]?.brokered) {
      fail(
        `${label} entry "${ref}" is a brokered extension point and is used through the platform`,
      );
    }
  }
}

/**
 * Validates the plugin manifest and returns it unchanged; throws ExtensionManifestError when
 * invalid.
 */
export function defineExtension(m: ExtensionManifest): ExtensionManifest {
  const plugin = typeof m?.name === "string" && m.name !== "" ? m.name : "<unnamed>";
  const fail = (msg: string): never => {
    throw new ExtensionManifestError(plugin, msg);
  };
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) {
    fail(`field "name" must match ${NAME_RE}`);
  }
  if (RESERVED_NAMES.has(m.name)) fail(`field "name" "${m.name}" is reserved`);
  if (typeof m.version !== "string" || semver.valid(m.version) === null) {
    fail(`field "version" must be a valid semver version`);
  }
  if (typeof m.sdk !== "string" || semver.validRange(m.sdk) === null) {
    fail(`field "sdk" must be a valid semver range`);
  }
  if (typeof m.setup !== "function") fail(`field "setup" must be a function`);
  if (m.dispose !== undefined && typeof m.dispose !== "function") {
    fail(`field "dispose" must be a function when present`);
  }
  if (!Array.isArray(m.provides)) fail(`field "provides" must be an array`);
  checkRefs("provides", m.provides, fail);
  if (new Set(m.provides).size !== m.provides.length) {
    fail(`field "provides" has duplicate entries`);
  }
  const requires = m.requires ?? [];
  checkRefs("requires", requires, fail, true);
  for (const r of requires) {
    if (m.provides.includes(r))
      fail(`field "requires" entry "${r}" is also provided by the same plugin`);
  }
  const optional = m.optional ?? [];
  if (!Array.isArray(optional)) fail(`field "optional" must be an array`);
  checkRefs("optional", optional, fail, true);
  for (const r of optional) {
    if (m.provides.includes(r) || requires.includes(r)) {
      fail(`field "optional" entry "${r}" overlaps with "provides" or "requires"`);
    }
  }
  if (m.permissions !== undefined) {
    const errs = validatePermissions(plugin, m.permissions);
    if (errs.length > 0) fail(`invalid permissions: ${errs.join("; ")}`);
  }
  // structural ui problems only; slot resolution never fails the extension (UI slots spec §3.2)
  const uiErrs = validateUiContributions(m.ui, m.permissions);
  if (uiErrs.length > 0) fail(`invalid ui: ${uiErrs.join("; ")}`);
  return m;
}
