// 违规 fixture：把违规代码藏进名叫 test / dist 的子目录再 re-export。
export * from "./test/impl.js";
export * from "./dist/impl.js";
