// 兄弟模块里的进程内状态：典型的「状态藏在 import 的模块里」写法。
export const counts = new Map<string, number>(); // capybara:allow-module-state 故意的反例，用于证明双副本工具能发现进程内状态
