/** The kernel bus topics and the job of the extension lifecycle (a leaf module: no imports). */

/**
 * 插件期望状态 / 快照变了（kernel bus 主题，频道 `cap:kernel:plugins.changed`，payload `{ plugin }`）。
 * 后台、CLI 写完 PG 后发布；各副本据此 reconcile，并作废路由闸门的名字缓存。
 */
export const PLUGINS_CHANGED_TOPIC = "plugins.changed";
/** 周期兜底（kernel bus 主题 `plugins.reconcile`，payload `{}`）：维护任务 `plugins-reconcile` 发布。 */
export const PLUGINS_RECONCILE_TOPIC = "plugins.reconcile";

/** The `@LockedInterval` job that publishes `plugins.reconcile` every `extensionHost.reconcileIntervalSeconds`. */
export const PLUGINS_RECONCILE_JOB = "plugins-reconcile";

/** 副本行心跳超过这么多个 reconcile 周期的副本不计入（C16；读状态的一方据此筛选）。 */
export const STALE_RECONCILE_PERIODS = 3;

/**
 * 部署配置保存之后（kernel bus 主题，频道 `cap:kernel:plugin-deployment-config`，payload `{ plugin }`）：
 * 各副本重读并校验——只改了 hot 字段就地替换，改了非 hot 字段重新加载实例，不合法保持当前值并告警；
 * 插件此刻待配置时，下一次 reconcile 加载它。
 */
export const PLUGIN_DEPLOYMENT_CONFIG_TOPIC = "plugin-deployment-config";
