"use client";

import { formatBytes, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiClientError, clientError } from "../lib/api";
import {
  type AttachmentLimits,
  DEFAULT_LIMITS,
  getAttachmentLimits,
  precheckFile,
  typeList,
  uploadAttachment,
} from "../lib/attachments";
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
  /** `error` 时的错误：内核错误码、`attachment.upload_failed` 或前端预检的错误码。 */
  error?: unknown;
  /** 原文件：失败后可用它重试（前端预检拦下的没有，不能重试）。 */
  file?: File;
}

/** 计入每条消息条数上限的条目：前端预检拦下的（没有原文件）不算。 */
const counts = (f: DraftFile) => !(f.status === "error" && f.file === undefined);

/** 前端预检的错误码（重试没有意义）。 */
const PRECHECK_CODES = new Set(["attachment.type_not_allowed", "attachment.too_large"]);

const codeOf = (e: unknown) => (e instanceof ApiClientError ? e.code : undefined);

/** 错误细节里带出的附件 id（内核 `attachment.not_found` / `not_ready` 的 `details[].attachmentId`）。 */
function failedIds(e: unknown): Set<string> {
  if (!(e instanceof ApiClientError)) return new Set();
  return new Set(
    e.rawDetails.flatMap((d) => {
      const id = (d as { attachmentId?: unknown } | null)?.attachmentId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}

/**
 * 输入框的上传文件：上限取自内核 `GET /attachments/limits`（取到之前用默认值兜底），加文件时先预检、
 * 通过的立即上传；条数按同步更新的 ref 计算，并发加文件（同时拖入、粘贴）也不会超过上限。
 */
export function useDraftFiles(orgId: string) {
  const t = useTranslations("chat");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [limits, setLimits] = useState<AttachmentLimits>(DEFAULT_LIMITS);
  const [files, setFilesState] = useState<DraftFile[]>([]);
  /** 与 `files` 同步的最新值：加文件时据此算剩余名额（state 在同一轮事件里还是旧值）。 */
  const filesRef = useRef<DraftFile[]>([]);
  /** 进行中的上传（移除或卸载时中止）。 */
  const uploads = useRef(new Map<string, AbortController>());
  const seq = useRef(0);

  const update = useCallback((fn: (list: DraftFile[]) => DraftFile[]) => {
    filesRef.current = fn(filesRef.current);
    setFilesState(filesRef.current);
  }, []);

  useEffect(() => {
    let live = true;
    getAttachmentLimits(orgId).then(
      (l) => {
        // 较早的内核没有 requestMediaBytes / available：缺的项用默认值补上
        if (live) setLimits({ ...DEFAULT_LIMITS, ...l });
      },
      () => {
        // 取不到时沿用默认值；以内核的错误码为准
      },
    );
    return () => {
      live = false;
    };
  }, [orgId]);

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
      uploadAttachment(orgId, file, {
        signal: ctrl.signal,
        onProgress: (p) => patch(key, { progress: p }),
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
    [orgId, patch],
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
    const total = (list: DraftFile[]) =>
      list.reduce((n, f) => n + (f.status === "error" ? 0 : f.size), 0);
    const before = total(filesRef.current);
    update((list) => [...list, ...added]);
    const after = total(filesRef.current);
    if (before <= limits.requestMediaBytes && after > limits.requestMediaBytes) {
      toast.error(t("filesOverBudget", { max: formatBytes(limits.requestMediaBytes) }));
    }
    for (const [key, file] of toStart) start(key, file);
  };

  const remove = (key: string) => {
    uploads.current.get(key)?.abort();
    uploads.current.delete(key);
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
      case "attachment.too_large":
        return t("fileTooLarge", {
          image: formatBytes(limits.imageMaxBytes),
          other: formatBytes(limits.maxBytes),
        });
      case "attachment.type_not_allowed":
        return t("fileTypeNotAllowed", { types: typeList(limits.types) });
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
    remove,
    retry,
    canRetry,
    removeSent,
    markFailed,
    errorText,
  };
}
