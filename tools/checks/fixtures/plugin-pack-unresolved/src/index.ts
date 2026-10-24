// 违规：依赖没装，打不成自包含的包。
import pad from "capybara-fixture-not-installed";

export default {
  name: "fixture-unresolved",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  setup() {
    pad();
  },
};
