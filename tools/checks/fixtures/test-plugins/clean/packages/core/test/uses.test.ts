// Every official plugin reference here is declared: alpha in tools/ci/test-plugins.json, gamma as a
// devDependency. The other lines look similar but are not references to workspace plugins.
import "@capybara-hq/plugin-gamma";

export const ALPHA = new URL("../../../plugins/alpha/src/index.ts", import.meta.url);
export const OWN_FIXTURE = new URL("./fixtures/plugins/beta/index.ts", import.meta.url);
export const URL_PATH = "/api/v1/orgs/o1/extensions/beta";
export const TEMPLATE_URL_PATH = (base: string) => `${base}/plugins/beta/ui`;
export const MANIFEST = { npm: "@capybara-hq/plugin-beta" };
export const NOT_A_PLUGIN = new URL("../../../plugins/zeta/src/index.ts", import.meta.url);
