// The plugin's test/ directory may import @capybara-hq/testing and model-fake (the model provider
// that drives agent runs); state rules are not scanned here.
import modelFake from "@capybara-hq/plugin-model-fake";
import { startReplicas } from "@capybara-hq/testing";

let allowedInTests = 0;
setTimeout(() => {}, 1);
export { allowedInTests, modelFake, startReplicas };
