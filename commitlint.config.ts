export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // 提交标题用中文，常以英文专有名词开头（HTTP、PG、Nacos、CLA），大小写规则不适用
    "subject-case": [0],
  },
};
