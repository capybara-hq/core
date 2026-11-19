import { type Document, isMap, isScalar, parseDocument } from "yaml";
import { LEGACY_OFF_NETWORK_CEILING, LEGACY_PERMISSION_KEYS } from "./load.js";
import { ConfigError } from "./types.js";

/** What {@link migratePermissionConfigText} did: the converted text and the keys it renamed. */
export interface PermissionConfigMigration {
  text: string;
  /** `old -> new` per converted key; empty when the document has no old key. */
  changed: string[];
}

const VALUES = ["allowed", "off"];

/**
 * The offline conversion of one config document (a config file, or a Nacos data id's content) to
 * the permission keys of the approval-only profiles design (`capybara config migrate-permissions`):
 * every old key (`devices.autoMode`, `devices.fullAccess`) is renamed in place to
 * `devices.outsideSandbox`, so unrelated keys, values, order and comments stay as they were. An
 * old key equal to an already present new key is dropped; a different one, or an invalid old
 * value, is refused (never pick the wider one, never guess). An old `off` also kept every device on
 * the allowlist, so the conversion sets `devices.network.ceiling: allowlist` (and narrows an open
 * `devices.network.default`): nothing widens. Nothing is read from or written to the environment,
 * PG or Nacos here: applying the result is the operator's reviewed change.
 */
export function migratePermissionConfigText(text: string): PermissionConfigMigration {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ConfigError("invalid YAML in the config document");
  const changed: string[] = [];
  let off = false;
  for (const key of LEGACY_PERMISSION_KEYS) {
    const [section, old] = key.path;
    const [, next] = key.replacement;
    const parent = doc.get(section, true);
    if (!isMap(parent) || !parent.has(old)) continue;
    const from = key.path.join(".");
    const to = key.replacement.join(".");
    const value = parent.get(old);
    if (typeof value !== "string" || !VALUES.includes(value))
      throw new ConfigError(`${from} must be allowed or off; fix it before converting`);
    if (value === "off") off = true;
    if (parent.has(next)) {
      if (parent.get(next) !== value)
        throw new ConfigError(
          `${from} and ${to} are both set and differ; keep one of them before converting`,
        );
      parent.delete(old);
    } else {
      const pair = parent.items.find((p) => (isScalar(p.key) ? p.key.value : p.key) === old);
      if (pair === undefined) continue;
      if (isScalar(pair.key)) pair.key.value = next;
      else pair.key = doc.createNode(next);
    }
    changed.push(`${from} -> ${to}`);
  }
  if (off && narrowNetworkToAllowlist(doc))
    changed.push(
      `${LEGACY_OFF_NETWORK_CEILING.path.join(".")}: ${LEGACY_OFF_NETWORK_CEILING.value} (an old off kept every device on the allowlist)`,
    );
  return { text: changed.length === 0 ? text : doc.toString(), changed };
}

/**
 * Sets `devices.network.ceiling` (and an open `devices.network.default`) to the allowlist, adding
 * the `network` map right after `devices.outsideSandbox` when there is none. Returns whether it
 * changed anything.
 */
function narrowNetworkToAllowlist(doc: Document): boolean {
  const devices = doc.get("devices", true);
  if (!isMap(devices)) return false;
  const network = devices.get("network", true);
  if (network === undefined || network === null) {
    const node = doc.createNode({ ceiling: LEGACY_OFF_NETWORK_CEILING.value });
    const at = devices.items.findIndex(
      (p) => (isScalar(p.key) ? p.key.value : p.key) === "outsideSandbox",
    );
    devices.items.splice(at + 1, 0, doc.createPair("network", node));
    return true;
  }
  if (!isMap(network))
    throw new ConfigError("devices.network must be a mapping; fix it before converting");
  let changed = false;
  for (const field of ["default", "ceiling"]) {
    const value = network.get(field);
    if (field === "default" && value === undefined) continue;
    if (value === LEGACY_OFF_NETWORK_CEILING.value) continue;
    if (value !== undefined && value !== "open")
      throw new ConfigError(
        `devices.network.${field} must be open or allowlist; fix it before converting`,
      );
    network.set(field, LEGACY_OFF_NETWORK_CEILING.value);
    changed = true;
  }
  return changed;
}

/** One environment variable the operator must rename before the old one stops being read. */
export type PermissionEnvRename =
  | { from: string; to: string }
  /** A variable to add (name=value; the value is a fixed narrowing, never an operator's value). */
  | { add: string };

/**
 * The old permission environment variables set in `env`, each with its replacement, plus the
 * network ceiling variable to add when an old one is `off` (never wider). The values are never
 * returned (the operator renames the variable and keeps its value). An old and a new variable, or
 * two old ones, with different values are refused, like the startup config does.
 */
export function legacyPermissionEnvRenames(env: NodeJS.ProcessEnv): PermissionEnvRename[] {
  const out: PermissionEnvRename[] = [];
  let off = false;
  const seen = new Map<string, string>();
  for (const key of LEGACY_PERMISSION_KEYS) {
    const old = env[key.env];
    if (old === undefined) continue;
    const current = env[key.replacementEnv];
    if (current !== undefined && current !== old)
      throw new ConfigError(
        `${key.env} and ${key.replacementEnv} are both set and differ; keep one of them`,
      );
    for (const [other, value] of seen)
      if (value !== old)
        throw new ConfigError(`${other} and ${key.env} are both set and differ; keep one of them`);
    seen.set(key.env, old);
    if (old === "off") off = true;
    out.push({ from: key.env, to: key.replacementEnv });
  }
  if (off)
    out.push({ add: `${LEGACY_OFF_NETWORK_CEILING.env}=${LEGACY_OFF_NETWORK_CEILING.value}` });
  return out;
}
