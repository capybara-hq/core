/**
 * 步长的小数位数，用于把 `value ± step` 的浮点误差抹掉（toFixed）。
 * 兼容 `String(1e-7) === "1e-7"` 这类指数写法；上限 10 位。
 */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const [mantissa = "", exponent = "0"] = String(step).toLowerCase().split("e");
  const fraction = (mantissa.split(".")[1] ?? "").length;
  return Math.min(10, Math.max(0, fraction - Number(exponent)));
}
