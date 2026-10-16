// 插件根的 test/ 目录：允许 import @capybara-hq/testing，不扫状态规则。
import { startReplicas } from "@capybara-hq/testing";

let allowedInTests = 0;
setTimeout(() => {}, 1);
export { allowedInTests, startReplicas };
