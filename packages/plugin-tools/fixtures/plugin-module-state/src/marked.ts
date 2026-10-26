// 豁免写法：同一行、紧邻上一行；带原因才有效。
const a = new Map<string, string>(); // capybara:allow-module-state 测试用的反例
// capybara:allow-module-state 紧邻上一行也可以
const b = new Set<string>();
// capybara:allow-module-state
const emptyReason = new Map<string, string>();
const blockComment = new Map<string, string>(); /* capybara:allow-module-state 块注释不算 */
// capybara:allow-module-state 隔了一行就不算

const tooFar = new Map<string, string>();
const x = 1; // capybara:allow-module-state 上一条语句行尾的注释不能顺带豁免下一行
const afterTrailing = new Map<string, string>();
export { a, afterTrailing, b, blockComment, emptyReason, tooFar, x };
