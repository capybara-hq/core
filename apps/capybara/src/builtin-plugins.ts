/**
 * 随 CLI 内置的插件（C14 / D13）：核心镜像只带 `openai-compatible` 与 `object-store-s3`。
 * 按模块从 CLI 自己的依赖解析（与运行目录无关），以 `builtinPlugins` 传给内核：来源 `builtin`，预先批准、
 * 始终启用、不需组织启用；部署配置没配好时为「待配置」，内核照常启动。
 */
export const BUILTIN_PLUGINS: readonly string[] = [
  import.meta.resolve("@capybara-hq/plugin-openai-compatible"),
  import.meta.resolve("@capybara-hq/plugin-object-store-s3"),
];
