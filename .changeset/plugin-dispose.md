---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

插件注册追踪与撤销（不重启的生命周期基础）：plugin-sdk 的 `PluginManifest` 新增可选 `dispose(ctx)`，`PluginContext` 新增 `signal`（实例被撤销时、在途调用排空之后中止）。内核为每个插件实例记一本账（工具、路由、队列 worker、bus 订阅、锁租约、界面 view / action、`provide`），新增 `PluginInstance` / `PluginRegistry` / `InflightTracker` / `loadInstance`，`PluginHost.unload` / `reload` / `current` / `onChange`：撤销时停止接新调用、排空在途工具调用与队列任务（`pluginHost.drainSeconds`），到时限仍未结束的工具调用以 `PLUGIN_UNLOADED_TOOL_ERROR` 交给模型，再逐项撤销登记并调用插件的 `dispose`；`requires` 它的插件随之卸下（原因 `dependency`，提供方回来后重新加载），`optional` 它的插件在本副本重新加载。插件路由保留挂载、实时取，撤销后返回 503 `plugin.unavailable`；渠道长连接在插件实例变化时交还并按新实例重新选主。配置声明的插件现在可以 `requires` 只由安装记录提供的能力（等安装记录加载完再加载）。新增配置 `pluginHost.disposeTimeoutSeconds`（插件 `dispose()` 时限，默认 10）与 `pluginHost.reloadSetupTimeoutSeconds`（运行中重新加载的 setup 时限，默认 60）；`ctx.signal` 在在途工具调用与队列任务都排空之后才中止；插件实例撤销或替换时中止它进行中的 HTTP 请求（SSE 等）；路由闸门按部署已知状态（内置、配置声明、PG 安装记录）决定 503 还是 404；插件队列 worker 的 `maxStalledCount` 为 3。
