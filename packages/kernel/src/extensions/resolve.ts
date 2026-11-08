import {
  EXTENSION_POINT_CARDINALITY,
  EXTENSION_POINTS,
  type ExtensionManifest,
  type ExtensionPointRef,
  OBJECT_STORE_EXTENSION_POINT,
  parseExtensionPoint,
} from "@capybara-hq/plugin-sdk";
import semver from "semver";

/**
 * Code of the {@link ExtensionResolveError} for a single-provider extension point that more than
 * one extension provides: nothing is missing, the extensions conflict (replica reason `conflict`).
 */
export const PROVIDER_CONFLICT = "extension.provider_conflict";

const CONFLICT_RE = /^extension point (\S+) is single-provider but provided by: (.+)$/;

/** The message (and replica `detail`) of a {@link PROVIDER_CONFLICT}; read back by {@link parseProviderConflict}. */
export function providerConflictMessage(extensionPoint: string, providers: string[]): string {
  return `extension point ${extensionPoint} is single-provider but provided by: ${providers.join(", ")}`;
}

/** The extension point and its providers from a {@link providerConflictMessage}; null for any other text. */
export function parseProviderConflict(
  detail: string | null,
): { extensionPoint: string; providers: string[] } | null {
  const m = detail === null ? null : CONFLICT_RE.exec(detail);
  if (!m) return null;
  return { extensionPoint: m[1] as string, providers: (m[2] as string).split(", ") };
}

/**
 * The single-provider extension points (`sandbox`, `object-store`, `secret-store`,
 * `config-source`; `EXTENSION_POINT_CARDINALITY`) among `provides`, sorted (the lock order).
 */
export function singlePointsOf(provides: readonly string[]): string[] {
  return [
    ...new Set(
      provides.filter((ref) => {
        try {
          return EXTENSION_POINT_CARDINALITY[parseExtensionPoint(ref).name] === "single";
        } catch {
          return false;
        }
      }),
    ),
  ].sort();
}

/** 插件依赖解析失败（信息列出插件名与能力名）。 */
export class ExtensionResolveError extends Error {
  constructor(
    message: string,
    /** Error code of the failure, when it has one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ExtensionResolveError";
  }
}

/**
 * 校验 sdk 范围、依赖满足度、单选能力唯一性与无环，返回按依赖拓扑排序后的列表（同层保持输入顺序）。
 * `requires` 缺提供方报错；`optional` 缺提供方不报错，但存在的提供方与 `requires` 一样参与排序与环检测。
 * 声明了 `permissions.storage` 的插件隐含依赖 `object-store@1`（中转能力，不能 `requires`）：提供方排在它前面；
 * 缺提供方不在这里报错，由权限闸门把它列为 pending（见 approvals.ts）。
 */
export function resolveExtensions(
  manifests: ExtensionManifest[],
  sdkVersion: string,
): ExtensionManifest[] {
  const seen = new Set<string>();
  for (const m of manifests) {
    if (seen.has(m.name))
      throw new ExtensionResolveError(`plugin ${m.name}: loaded more than once`);
    seen.add(m.name);
    if (!semver.satisfies(sdkVersion, m.sdk)) {
      throw new ExtensionResolveError(
        `plugin ${m.name}: sdk range "${m.sdk}" is not satisfied by SDK_VERSION ${sdkVersion}`,
      );
    }
  }

  for (const m of manifests) {
    for (const ref of m.provides) {
      const { name, major } = parseExtensionPoint(ref);
      const majors = EXTENSION_POINTS[name]?.majors;
      if (majors && !majors.includes(major)) {
        throw new ExtensionResolveError(
          `Plugin ${m.name} provides ${ref}, which this kernel no longer supports; upgrade it to a version that provides ${name}@${Math.max(...majors)}.`,
          "extension.unsupported_extension_point",
        );
      }
    }
  }

  const providers = new Map<ExtensionPointRef, ExtensionManifest[]>();
  for (const m of manifests) {
    for (const cap of m.provides) providers.set(cap, [...(providers.get(cap) ?? []), m]);
  }
  for (const [cap, list] of providers) {
    if (
      EXTENSION_POINT_CARDINALITY[parseExtensionPoint(cap).name] === "single" &&
      list.length > 1
    ) {
      throw new ExtensionResolveError(
        providerConflictMessage(
          cap,
          list.map((p) => p.name),
        ),
        PROVIDER_CONFLICT,
      );
    }
  }
  for (const m of manifests) {
    for (const cap of m.requires ?? []) {
      if (!providers.has(cap)) {
        throw new ExtensionResolveError(
          `plugin ${m.name}: required extension point ${cap} has no provider`,
        );
      }
    }
  }

  const done = new Set<string>();
  const visiting: string[] = [];
  const out: ExtensionManifest[] = [];
  const visit = (m: ExtensionManifest): void => {
    if (done.has(m.name)) return;
    if (visiting.includes(m.name)) {
      const cycle = [...visiting.slice(visiting.indexOf(m.name)), m.name].join(" -> ");
      throw new ExtensionResolveError(`dependency cycle: ${cycle}`);
    }
    visiting.push(m.name);
    for (const cap of [...(m.requires ?? []), ...(m.optional ?? [])]) {
      for (const p of providers.get(cap) ?? []) visit(p);
    }
    if (m.permissions?.storage) {
      for (const p of providers.get(OBJECT_STORE_EXTENSION_POINT) ?? []) if (p !== m) visit(p);
    }
    visiting.pop();
    done.add(m.name);
    out.push(m);
  };
  for (const m of manifests) visit(m);
  return out;
}
