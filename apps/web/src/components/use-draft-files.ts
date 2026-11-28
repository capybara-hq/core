"use client";

import { formatBytes, useToast } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, clientError } from "../lib/api";
import { retryOnMountOf } from "../lib/query/client";
import { attachmentLimitsQuery } from "../lib/query/conversation";
import { useAppMutation } from "../lib/query/mutation";
import {
  DEFAULT_LIMITS,
  discardDraft,
  precheckFile,
  typeList,
  type UploadLimits,
  uploadFile,
} from "../lib/uploads";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * 草稿里上传的文件（与 `@` 资源引用分开管理）：选中即开始上传（登记 → 直传 → finalize），
 * `ready` 后带 `id`，发送时作为 `files` 引用。
 */
export interface DraftFile {
  /** 本地 key（上传完成前还没有附件 id）。 */
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  progress: number;
  /** 附件 id（`ready` 时有）。 */
  id?: string;
  /** The error when `error`: a kernel error code, `file.upload_failed` or a precheck code. */
  error?: unknown;
  /** 原文件：失败后可用它重试（前端预检拦下的没有，不能重试）。 */
  file?: File;
  /**
   * A file picked from the person's file library (`@` or File library): ready at once, no upload, and
   * never discarded on the kernel (it stays in the library when it leaves the draft).
   */
  library?: true;
  /** The library file's content type (its type mark; an upload's comes from `file`). */
  contentType?: string;
}

/** 计入每条消息条数上限的条目：前端预检拦下的（没有原文件）不算。 */
const counts = (f: DraftFile) => !(f.status === "error" && f.file === undefined);

/** 前端预检的错误码（重试没有意义）。 */
const PRECHECK_CODES = new Set(["file.type_not_allowed", "file.too_large"]);

const codeOf = (e: unknown) => (e instanceof ApiClientError ? e.code : undefined);

/** The file ids an error names (`details[].fileId` of `file.not_found` / `not_ready`). */
function failedIds(e: unknown): Set<string> {
  if (!(e instanceof ApiClientError)) return new Set();
  return new Set(
    e.rawDetails.flatMap((d) => {
      const id = (d as { fileId?: unknown } | null)?.fileId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

/**
 * The composer's uploads: limits come from the kernel's `GET /files/limits` (defaults until they
 * arrive); an added file is prechecked and uploads at once when it passes; the count is kept in a
 * ref updated synchronously, so concurrent adds (a drop and a paste together) never pass the cap.
 */
export function useDraftFiles(orgId: string, initial: readonly DraftFile[] = []) {
  const t = useTranslations("chat");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  // Until the limits are read (or when the read failed) the defaults apply.
  const limitsQ = attachmentLimitsQuery(orgId);
  const read = useQuery({ ...limitsQ, retryOnMount: retryOnMountOf(limitsQ.queryKey) }).data;
  const limits = useMemo<UploadLimits>(() => read ?? DEFAULT_LIMITS, [read]);
  // An upload's answer is the attachment: nothing cached changes.
  const { mutateAsync: upload } = useAppMutation({
    fn: (v: {
      file: File;
      signal: AbortSignal;
      onProgress(p: number): void;
      onCreated(id: string): void;
    }) =>
      uploadFile(orgId, v.file, {
        signal: v.signal,
        onProgress: v.onProgress,
        onCreated: v.onCreated,
      }),
    invalidates: () => [],
  });
  // Drops a draft on the kernel; the answer changes nothing cached.
  const { mutateAsync: discard } = useAppMutation({
    fn: (id: string) => discardDraft(orgId, id),
    invalidates: () => [],
  });
  // `initial`: a failed send's files given back to a new composer (their uploads are done).
  const [files, setFilesState] = useState<DraftFile[]>(() => [...initial]);
  /** 与 `files` 同步的最新值：加文件时据此算剩余名额（state 在同一轮事件里还是旧值）。 */
  const filesRef = useRef<DraftFile[]>([...initial]);
  /** 进行中的上传（移除或卸载时中止）。 */
  const uploads = useRef(new Map<string, AbortController>());
  /** The file ids the kernel registered for uploads still in flight (a removal discards them). */
  const created = useRef(new Map<string, string>());
  // New keys never repeat a given-back file's `f<n>`.
  const seq = useRef(initial.reduce((n, f) => Math.max(n, Number(f.key.slice(1)) || 0), 0));

  const update = useCallback((fn: (list: DraftFile[]) => DraftFile[]) => {
    filesRef.current = fn(filesRef.current);
    setFilesState(filesRef.current);
  }, []);

  useEffect(() => {
    const map = uploads.current;
    return () => {
      for (const c of map.values()) c.abort();
      map.clear();
    };
  }, []);

  const patch = useCallback(
    (key: string, p: Partial<DraftFile>) =>
      update((list) => list.map((f) => (f.key === key ? { ...f, ...p } : f))),
    [update],
  );

  /** 开始（或重新开始）上传某个条目。 */
  const start = useCallback(
    (key: string, file: File) => {
      uploads.current.get(key)?.abort();
      const ctrl = new AbortController();
      uploads.current.set(key, ctrl);
      upload({
        file,
        signal: ctrl.signal,
        onProgress: (p) => patch(key, { progress: p }),
        onCreated: (id) => {
          // Removed between the registration and its answer: nobody will ever send this draft.
          if (ctrl.signal.aborted) {
            void discard(id);
            return;
          }
          const previous = created.current.get(key);
          if (previous !== undefined && previous !== id) void discard(previous);
          created.current.set(key, id);
        },
      })
        .then(
          (view) => {
            if (!ctrl.signal.aborted) patch(key, { status: "ready", progress: 1, id: view.id });
          },
          (e: unknown) => {
            if (!ctrl.signal.aborted) patch(key, { status: "error", error: e });
          },
        )
        .finally(() => {
          if (uploads.current.get(key) === ctrl) uploads.current.delete(key);
        });
    },
    [upload, patch, discard],
  );

  /**
   * 加文件（选择 / 拖入 / 粘贴）：预检，通过的立即上传；超出条数上限的不收。存储不可用时一个都不收。
   * 收下后合计大小首次超过单次请求的预算时提醒（发送后较早的文件会被省略）。
   */
  const add = (picked: File[]) => {
    if (!limits.available) {
      toast.error(t("filesUnavailable"));
      return;
    }
    // 预检拦下的条目（不会发出去、只是提示）不占条数名额
    let room = Math.max(0, limits.maxPerMessage - filesRef.current.filter(counts).length);
    let overflow = false;
    const added: DraftFile[] = [];
    const toStart: [string, File][] = [];
    for (const file of picked) {
      const rejected = precheckFile(file, limits);
      if (rejected === null && room === 0) {
        overflow = true;
        continue;
      }
      seq.current += 1;
      const key = `f${seq.current}`;
      const base = { key, name: file.name, size: file.size, progress: 0 };
      if (rejected !== null) {
        added.push({ ...base, status: "error", error: clientError(rejected) });
      } else {
        room -= 1;
        added.push({ ...base, status: "uploading", file });
        toStart.push([key, file]);
      }
    }
    if (overflow) toast.error(t("filesLimit", { max: limits.maxPerMessage }));
    if (added.length === 0) return;
    append(added);
    for (const [key, file] of toStart) start(key, file);
  };

  /**
   * Appends files to the draft; the first time their total passes the request's media budget a
   * toast says so (the earlier files are left out once sent).
   */
  const append = (added: DraftFile[]) => {
    const total = (list: DraftFile[]) =>
      list.reduce((n, f) => n + (f.status === "error" ? 0 : f.size), 0);
    const before = total(filesRef.current);
    update((list) => [...list, ...added]);
    const after = total(filesRef.current);
    if (before <= limits.requestMediaBytes && after > limits.requestMediaBytes) {
      toast.error(t("filesOverBudget", { max: formatBytes(limits.requestMediaBytes) }));
    }
  };

  /**
   * Adds a file of the person's library (composer menus §4): ready at once with its id, no upload.
   * One already in the draft is not added twice; the per-message count applies as for uploads.
   */
  const addLibrary = (file: { id: string; name: string; size: number; contentType?: string }) => {
    if (filesRef.current.some((f) => f.id === file.id)) return;
    if (!limits.available) {
      toast.error(t("filesUnavailable"));
      return;
    }
    if (filesRef.current.filter(counts).length >= limits.maxPerMessage) {
      toast.error(t("filesLimit", { max: limits.maxPerMessage }));
      return;
    }
    seq.current += 1;
    append([
      {
        key: `f${seq.current}`,
        name: file.name,
        size: file.size,
        status: "ready",
        progress: 1,
        id: file.id,
        library: true,
        ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
      },
    ]);
  };

  const remove = (key: string) => {
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
    // A draft the kernel registered (finished or in flight) is dropped there too (best effort);
    // a library file is the person's own and stays.
    const f = filesRef.current.find((x) => x.key === key);
    const id = f?.library ? undefined : (f?.id ?? created.current.get(key));
    created.current.delete(key);
    if (id !== undefined) void discard(id);
    update((list) => list.filter((f) => f.key !== key));
  };

  /** 失败的条目用同一个文件重新上传（前端预检拦下的不能重试）。 */
  const retry = (key: string) => {
    const f = filesRef.current.find((x) => x.key === key);
    if (!f?.file) return;
    const { file } = f;
    update((list) =>
      list.map((x) => {
        if (x.key !== key) return x;
        const { id: _id, error: _error, ...rest } = x;
        return { ...rest, status: "uploading" as const, progress: 0 };
      }),
    );
    start(key, file);
  };

  const canRetry = (f: DraftFile) =>
    f.status === "error" && f.file !== undefined && !PRECHECK_CODES.has(codeOf(f.error) ?? "");

  /** 发送成功：只移除发出去的那些（发送期间新加的保留）。 */
  const removeSent = (keys: readonly string[]) => {
    const sent = new Set(keys);
    update((list) => list.filter((f) => !sent.has(f.key)));
  };

  /**
   * A send clears the composer at once: the sent files leave the draft (returned, so a failed
   * send can put them back with {@link restore}). Their uploads are done, so nothing is aborted.
   */
  const take = (keys: readonly string[]): DraftFile[] => {
    const sent = new Set(keys);
    const taken = filesRef.current.filter((f) => sent.has(f.key));
    update((list) => list.filter((f) => !sent.has(f.key)));
    return taken;
  };

  /** A failed send: its files come back first, before any added since (none twice). */
  const restore = (back: readonly DraftFile[]) => {
    if (back.length === 0) return;
    update((list) => {
      const have = new Set(list.map((f) => f.key));
      return [...back.filter((f) => !have.has(f.key)), ...list];
    });
  };

  /** 发送失败：内核指出了哪个附件不存在 / 未就绪时，把对应条目标为出错（可重试）。 */
  const markFailed = (e: unknown) => {
    const ids = failedIds(e);
    if (ids.size === 0) return;
    update((list) =>
      list.map((f) =>
        f.id !== undefined && ids.has(f.id) ? { ...f, status: "error", error: e } : f,
      ),
    );
  };

  /** 条目的错误文字：大小 / 类型超限按当前上限拼出，其余按错误码翻译。 */
  const errorText = (f: DraftFile): string => {
    switch (codeOf(f.error)) {
      case "file.too_large":
        return t("fileTooLarge", {
          image: formatBytes(limits.imageMaxBytes),
          other: formatBytes(limits.maxBytes),
        });
      case "file.type_not_allowed":
        return t("fileTypeNotAllowed", {
          types: typeList(limits.types, (count) => t("fileTypeMore", { count })),
        });
      default:
        return errorMessage(f.error);
    }
  };

  return {
    files,
    limits,
    /** 上传中或有出错的文件时不能发送（出错的要先移除或重试，免得悄悄丢掉）。 */
    blocking: files.some((f) => f.status !== "ready"),
    add,
    addLibrary,
    remove,
    retry,
    canRetry,
    removeSent,
    take,
    restore,
    markFailed,
    errorText,
  };
}
