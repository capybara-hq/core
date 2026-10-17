// 违规 fixture：模块顶层的进程内状态。每个「应报」的声明行尾都标了 FLAG 便于核对。
let counter = 0; // FLAG
var legacyCounter = 0; // FLAG
export let exported = 1; // FLAG
const cache = new Map<string, string>(); // FLAG
const seen = new Set<string>(); // FLAG
const weak = new WeakMap<object, string>(); // FLAG
const weakSet = new WeakSet<object>(); // FLAG
const list: string[] = []; // FLAG
const asserted = [] as string[]; // FLAG
const wrapped = (new Map() as Map<string, string>); // FLAG
export const exportedMap = new Map<string, string>(); // FLAG

// 以下都不应报：
const name = "plain";
const config = { retries: 3 };
const frozenFn = () => new Map<string, string>();

export function handler(): number {
  let local = 0;
  const localMap = new Map<string, string>();
  local += localMap.size;
  return local + counter + legacyCounter + exported + cache.size + seen.size + weak.constructor.length;
}

export { asserted, config, frozenFn, list, name, weakSet, wrapped };
