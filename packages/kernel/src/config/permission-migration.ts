import { isMap, isScalar, parseDocument } from "yaml";
import { LEGACY_PERMISSION_KEYS } from "./load.js";
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
 * the permission keys B1 introduced (`capybara config migrate-permissions`): every old key is
 * renamed in place to its replacement, so unrelated keys, values, order and comments stay as they
 * were. An old key equal to an already present new key is dropped; a different one, or an invalid
 * old value, is refused (never pick the wider one, never guess). Nothing is read from or written
 * to the environment, PG or Nacos here: applying the result is the operator's reviewed change.
 */
export function migratePermissionConfigText(text: string): PermissionConfigMigration {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new ConfigError("invalid YAML in the config document");
  const changed: string[] = [];
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
  return { text: changed.length === 0 ? text : doc.toString(), changed };
}

/** One environment variable the operator must rename before the old one stops being read. */
export interface PermissionEnvRename {
  from: string;
  to: string;
}

/**
 * The old permission environment variables set in `env`, each with its replacement. The values
 * are never returned (the operator renames the variable and keeps its value). Both set with
 * different values is refused, like the startup config does.
 */
export function legacyPermissionEnvRenames(env: NodeJS.ProcessEnv): PermissionEnvRename[] {
  const out: PermissionEnvRename[] = [];
  for (const key of LEGACY_PERMISSION_KEYS) {
    const old = env[key.env];
    if (old === undefined) continue;
    const current = env[key.replacementEnv];
    if (current !== undefined && current !== old)
      throw new ConfigError(
        `${key.env} and ${key.replacementEnv} are both set and differ; keep one of them`,
      );
    out.push({ from: key.env, to: key.replacementEnv });
  }
  return out;
}
