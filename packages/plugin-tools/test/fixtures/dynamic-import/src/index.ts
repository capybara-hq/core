// 违规：非字面量的动态 import（打包后原样保留，校验必须拒绝）。
const name = ["left", "pad"].join("-");

export default {
  name: "fixture-dynamic",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  async setup() {
    await import(name);
  },
};
