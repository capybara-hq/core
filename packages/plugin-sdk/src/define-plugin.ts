import semver from "semver";
import type { z } from "zod";
import { CAPABILITIES, type CapabilityRef, parseCapability } from "./capability.js";
import type { PluginContext } from "./ctx.js";
import {
  type PluginPermissions,
  validatePermissions,
  validateUiContributions,
} from "./permissions.js";
import type { UiContribution } from "./ui.js";

/** 插件清单。 */
export interface PluginManifest {
  name: string;
  version: string;
  sdk: string;
  provides: CapabilityRef[];
  requires?: CapabilityRef[];
  /** 可选依赖：缺失时插件照常加载，运行时经 ctx.capabilities 判断。 */
  optional?: CapabilityRef[];
  /** 权限清单（治理而非沙箱）。 */
  permissions?: PluginPermissions;
  /** 界面贡献：对话页标签与组织页面；id 须同时列在 `permissions.ui` 里。 */
  ui?: UiContribution[];
  config?: { deployment?: z.ZodTypeAny; org?: z.ZodTypeAny };
  migrations?: string;
  setup(ctx: PluginContext): void | Promise<void>;
  /**
   * 可选：插件实例被撤销（停用、卸载、升级换新实例、依赖方随提供方重新加载）时调用。
   * 调用时内核已经：停止接新的调用、等在途调用结束（最多 `pluginHost.drainSeconds`）、中止 `ctx.signal`、
   * 撤销本实例经 ctx 做过的全部登记（工具、路由、队列 worker、bus 订阅、锁租约、界面、provide）。
   * 这里只收拾插件自己在 ctx 之外开的东西（如自建的连接）；不要再经 ctx 登记任何东西。
   * setup 抛错时不调用（已登记的由内核撤销）。
   */
  dispose?(ctx: PluginContext): void | Promise<void>;
}

/** 插件清单不合法。 */
export class PluginManifestError extends Error {
  constructor(plugin: string, message: string) {
    super(`plugin ${plugin}: ${message}`);
    this.name = "PluginManifestError";
  }
}

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** 保留的插件名：内核用 `kernel` 作为自己的 secrets 命名空间，插件不能与之相同。 */
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
      name = parseCapability(ref).name;
    } catch {
      fail(`${label} entry "${ref}" is not a valid capability ref`);
    }
    if (!Object.hasOwn(CAPABILITIES, name)) {
      fail(`${label} entry "${ref}" references unregistered capability "${name}"`);
    }
    if (forbidBrokered && CAPABILITIES[name]?.brokered) {
      fail(`${label} entry "${ref}" is a brokered capability and is used through the platform`);
    }
  }
}

/** 校验并原样返回插件清单；不合法抛 PluginManifestError。 */
export function definePlugin(m: PluginManifest): PluginManifest {
  const plugin = typeof m?.name === "string" && m.name !== "" ? m.name : "<unnamed>";
  const fail = (msg: string): never => {
    throw new PluginManifestError(plugin, msg);
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
  const uiErrs = validateUiContributions(m.ui, m.permissions);
  if (uiErrs.length > 0) fail(`invalid ui: ${uiErrs.join("; ")}`);
  return m;
}
