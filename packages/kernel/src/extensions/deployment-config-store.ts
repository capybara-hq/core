import type { core } from "zod";
import { configFields, getPath } from "../config/fields.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";

type Obj = Record<string, unknown>;

/**
 * The stored half of the deployment-level extension config (C10): where PG keeps it, how it is read
 * back and merged under the startup config. Pure helpers shared by the extension installs (the
 * desired state the host loads with), the admin service and the CLI.
 */

/** 部署级插件配置的密钥存在 `capybara.secrets` 的这个 org_id 下（不是真实组织；namespace `kernel`）。 */
export const DEPLOYMENT_SECRETS_ORG = "_deployment";
/** 内核自己的 secrets 命名空间（`kernel` 是保留插件名）。 */
export const SECRETS_NAMESPACE = "kernel";
const SECRET_KEY_PREFIX = "plugin-deployment-config:";
export const secretKey = (plugin: string, path: string) => `${SECRET_KEY_PREFIX}${plugin}:${path}`;

/** 一个插件的部署级配置描述：真实模块的 zod schema（有的话）与字段清单。 */
export interface DeploymentSchemaInfo {
  version: string;
  schema?: core.$ZodType | undefined;
  fields: { path: string; secret: boolean; hot: boolean }[];
}

/** 由 zod schema 得出字段清单（`configFields`：对象路径上的叶子，secret 向下继承）。 */
export function schemaFields(schema: core.$ZodType | undefined): DeploymentSchemaInfo["fields"] {
  if (!schema) return [];
  return configFields(schema).map((f) => ({
    path: f.path,
    secret: f.meta?.secret === true,
    hot: f.meta?.hot === true,
  }));
}

export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 按点路径设值，缺失的中间对象自动创建；中间节点不是对象时放弃。 */
export function setDeep(obj: Obj, path: string, value: unknown): void {
  const segs = path.split(".");
  let node: Obj = obj;
  for (const seg of segs.slice(0, -1)) {
    const next = node[seg];
    if (next === undefined) node[seg] = {};
    else if (!isObj(next)) return;
    node = node[seg] as Obj;
  }
  node[segs[segs.length - 1] as string] = value;
}

/** 按点路径删除键；删完变空的中间对象一并删掉。 */
export function deleteDeep(obj: Obj, path: string): void {
  const segs = path.split(".");
  const chain: Obj[] = [obj];
  let node: unknown = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node)) return;
    node = node[seg];
    if (!isObj(node)) return;
    chain.push(node);
  }
  delete (chain[chain.length - 1] as Obj)[segs[segs.length - 1] as string];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i] as Obj).length > 0) break;
    delete (chain[i - 1] as Obj)[segs[i - 1] as string];
  }
}

/** 叶子点路径（对象递归；其余都是叶子）。 */
function leafPaths(value: unknown, prefix = "", out: string[] = []): string[] {
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix !== "") out.push(prefix);
  return out;
}

/** 启动配置（文件 / 环境变量合并后的值）是否覆盖了这个字段：给了它、它下面的值，或在祖先上给了非对象值。 */
function coveredBy(fileValue: unknown, path: string): boolean {
  let node = fileValue;
  for (const seg of path.split(".")) {
    if (node === undefined) return false;
    if (!isObj(node)) return true;
    node = node[seg];
  }
  return node !== undefined;
}

/**
 * 合并一个插件的部署配置（C10 的优先级：环境变量 > 文件 / Nacos > PG > schema 默认值）：以启动配置
 * （`fileValue`，已含环境变量）为底，逐字段补上 PG 里保存、而启动配置没有覆盖的值。按字段合并：启动配置给了的字段
 * 整个以它为准（不与 PG 的值深合并）。`fields` 为字段点路径（没有 schema 时用 PG 值的叶子路径）。默认值由校验补上。
 */
export function mergeDeploymentConfig(
  stored: Obj,
  fileValue: unknown,
  fields: string[] = leafPaths(stored),
): unknown {
  if (fileValue !== undefined && !isObj(fileValue)) return fileValue;
  const out: Obj = structuredClone((fileValue as Obj | undefined) ?? {});
  for (const path of fields) {
    const v = getPath(stored, path);
    if (v === undefined || coveredBy(fileValue, path)) continue;
    setDeep(out, path, structuredClone(v));
  }
  return out;
}

/**
 * PG 里一个插件保存的部署配置（非密钥字段 + 解密的密钥字段，按点路径放回对象）。只并入 `secretPaths`（当前
 * schema 里是密钥的字段）的密钥：旧版本留下、现在已不是密钥或已删掉的字段不解密、不并入（否则会被当成明文回显
 * 或保存）。
 */
export async function readStoredDeploymentConfig(
  db: KernelSchemaDb,
  keyring: Keyring,
  plugin: string,
  opts: { forUpdate?: boolean; secretPaths: readonly string[] },
): Promise<Obj> {
  let q = db
    .selectFrom("extension_deployment_configs")
    .select("config")
    .where("plugin", "=", plugin);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  const out: Obj = structuredClone(row?.config ?? {});
  const prefix = secretKey(plugin, "");
  const wanted = new Set(opts.secretPaths);
  if (wanted.size === 0) return out;
  const keys = await db
    .selectFrom("secrets")
    .select("key")
    .where("namespace", "=", SECRETS_NAMESPACE)
    .where("org_id", "=", DEPLOYMENT_SECRETS_ORG)
    .execute();
  const secrets = createSecrets(db, keyring, SECRETS_NAMESPACE);
  for (const { key } of keys) {
    if (!key.startsWith(prefix) || !wanted.has(key.slice(prefix.length))) continue;
    const v = await secrets.get(DEPLOYMENT_SECRETS_ORG, key);
    if (v !== null) setDeep(out, key.slice(prefix.length), JSON.parse(v));
  }
  return out;
}

/** 字段清单里的密钥字段路径。 */
export const secretPathsOf = (fields: DeploymentSchemaInfo["fields"]): string[] =>
  fields.filter((f) => f.secret).map((f) => f.path);
