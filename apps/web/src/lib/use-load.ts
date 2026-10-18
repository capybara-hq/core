"use client";

import { type DependencyList, useCallback, useEffect, useState } from "react";
import { ApiClientError } from "./api";

export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "error"; code: string };

/**
 * 读取一份数据：依赖变化或 `reload()` 时重读（重读期间保留上一次的数据，不闪回加载中）；
 * `set` 用接口返回的新数据直接替换（如保存后）。错误以内核错误码表示。
 */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: DependencyList,
): { state: Loaded<T>; reload(): void; set(data: T): void } {
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 由调用方给出依赖；nonce 触发重读
  useEffect(() => {
    let disposed = false;
    load().then(
      (data) => {
        if (!disposed) setState({ kind: "ready", data });
      },
      (e: unknown) => {
        if (!disposed)
          setState({ kind: "error", code: e instanceof ApiClientError ? e.code : "unknown" });
      },
    );
    return () => {
      disposed = true;
    };
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((data: T) => setState({ kind: "ready", data }), []);
  return { state, reload, set };
}
