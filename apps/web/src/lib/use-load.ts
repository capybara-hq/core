"use client";

import { type DependencyList, useCallback, useEffect, useState } from "react";
import { ApiClientError } from "./api";

export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; code: string };

/** 依赖的身份（依赖都是 id 一类的标量）。 */
const keyOf = (deps: DependencyList) => JSON.stringify(deps);

/**
 * 读取一份数据。
 * - 依赖变化（如切换组织、换了路由参数）：立即回到加载中，不再显示上一组依赖的数据——
 *   同一渲染里就判定，旧数据一帧也不会以新依赖的身份出现；
 * - `reload()`：同一组依赖重读，期间保留上一次的数据（不闪回加载中）；
 * - `set`：用接口返回的新数据直接替换（如保存后）。
 * 错误以内核错误码表示。
 */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: DependencyList,
): { state: Loaded<T>; reload(): void; set(data: T): void } {
  const key = keyOf(deps);
  const [stored, setStored] = useState<{ key: string; state: Loaded<T> }>({
    key,
    state: { kind: "loading" },
  });
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖由调用方给出（以 key 表示）；nonce 触发重读
  useEffect(() => {
    let disposed = false;
    load().then(
      (data) => {
        if (!disposed) setStored({ key, state: { kind: "ready", data } });
      },
      (e: unknown) => {
        if (!disposed)
          setStored({
            key,
            state: { kind: "error", code: e instanceof ApiClientError ? e.code : "unknown" },
          });
      },
    );
    return () => {
      disposed = true;
    };
  }, [key, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((data: T) => setStored({ key, state: { kind: "ready", data } }), [key]);
  const state: Loaded<T> = stored.key === key ? stored.state : { kind: "loading" };
  return { state, reload, set };
}
