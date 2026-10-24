import { fileURLToPath } from "node:url";
import type { ExtensionHost } from "../../src/extensions/host.js";
import type { FakeBProvider } from "../fixtures/plugins/model-fake-b/index.js";

/** 官方 `model-fake` 插件源码入口（内核不依赖插件包，按路径加载）。 */
export const MODEL_FAKE = fileURLToPath(
  new URL("../../../../plugins/model-fake/src/index.ts", import.meta.url),
);

/** 第二个供应商 fixture `model-fake-b`（模型 b-1、b-2）。 */
export const MODEL_FAKE_B = fileURLToPath(
  new URL("../fixtures/plugins/model-fake-b/index.ts", import.meta.url),
);

/** 加载两个模型供应商的内核配置片段：model-fake 配 fake-1、fake-2。 */
export const MODEL_PLUGINS_CONFIG = {
  plugins: [MODEL_FAKE, MODEL_FAKE_B],
  pluginPermissions: { autoApprove: true },
  pluginConfig: { "model-fake": { models: [{ id: "fake-1" }, { id: "fake-2" }] } },
};

/** 读 `model-fake-b` 的 listModels 调用次数。 */
export function fakeBCalls(host: ExtensionHost): number {
  const entry = host.list("model-provider").find((p) => p.plugin === "model-fake-b");
  if (!entry) throw new Error("model-fake-b not loaded");
  return (entry.impl as FakeBProvider).listModelsCalls;
}
