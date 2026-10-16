// 违规 fixture：相对路径逃出 plugin-sdk 包目录。
export { x } from "../../kernel/src/index.js";
export { y } from "./inside.js";
