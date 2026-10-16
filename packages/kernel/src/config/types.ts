/** 配置来源：`load` 取原始配置，`watch` 可选地订阅变更并返回取消函数；`onError` 接收监听过程中的（已脱敏）错误。 */
export interface ConfigSource {
  load(): Promise<unknown>;
  watch?(onChange: (raw: unknown) => void, onError?: (err: Error) => void): () => void;
}

/** 配置加载或校验失败。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
