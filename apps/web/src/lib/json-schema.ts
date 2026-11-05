/** 内核下发的配置 JSON Schema（插件 `config.org`、渠道 `connectionSchema` 转换而来）。 */
export type JsonSchema = Record<string, unknown>;

/**
 * One reason a config failed validation (kernel `ConfigIssue`): the joined path, the zod path
 * unjoined (`segments`, record keys may contain dots) and a generated message; `messageKey` names a
 * root `x-ui.messages` entry the form shows instead, in the page locale.
 */
export interface ConfigIssue {
  path: string;
  segments?: (string | number)[];
  message: string;
  messageKey?: string;
}
