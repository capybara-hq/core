import {
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/button";
import { useDesignT } from "../provider";

/* 对话附件：输入框里的上传条目、拖放 / 粘贴区域、选文件按钮、消息里的附件（spec §6.9）。 */

/** 字节数的简短写法：`512 B`、`1.5 KB`、`20 MB`（1024 进制，一位小数，整数时省略小数）。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const r = Math.round(v * 10) / 10;
  return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} ${units[i]}`;
}

/** 进度条段数（与 Toast 进度一致）。 */
const SEGMENTS = 10;

export type AttachmentChipStatus = "uploading" | "ready" | "error";

export type AttachmentChipProps = {
  name: string;
  /** 字节数。 */
  size: number;
  status: AttachmentChipStatus;
  /** 上传进度 0–1（`uploading` 时显示）。 */
  progress?: number;
  /** `error` 时显示的错误文字。 */
  error?: string;
  /** 不传则不显示移除按钮。 */
  onRemove?: () => void;
  /** `error` 时给了它就显示「重试」按钮。 */
  onRetry?: () => void;
};

/** 输入框里待发送的上传文件：名称、大小、上传进度 / 错误、移除。 */
export function AttachmentChip({
  name,
  size,
  status,
  progress = 0,
  error,
  onRemove,
  onRetry,
}: AttachmentChipProps) {
  const t = useDesignT();
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <div className="cb-attachment-chip" data-status={status}>
      <div className="cb-attachment-chip-head">
        <span className="cb-attachment-chip-name" title={name}>
          {name}
        </span>
        <span className="cb-attachment-chip-size">{formatBytes(size)}</span>
        {status === "error" && onRetry ? (
          <IconButton
            density="dense"
            icon="↻"
            label={t("attachment.retry").replace("{name}", name)}
            onClick={onRetry}
          />
        ) : null}
        {onRemove ? (
          <IconButton
            density="dense"
            icon="✕"
            label={t("attachment.remove").replace("{name}", name)}
            onClick={onRemove}
          />
        ) : null}
      </div>
      {status === "uploading" ? (
        <div
          className="cb-attachment-chip-bar"
          role="progressbar"
          aria-label={t("attachment.uploading").replace("{name}", name)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          {Array.from({ length: SEGMENTS }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: 固定段数
              key={i}
              data-on={i < Math.round((pct / 100) * SEGMENTS) ? "true" : undefined}
            />
          ))}
        </div>
      ) : null}
      {status === "error" && error ? (
        <span className="cb-attachment-chip-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const hasFiles = (dt: DataTransfer | null): boolean =>
  dt !== null && Array.from(dt.types ?? []).includes("Files");

export type FileDropProps = {
  /** 拖入时覆盖层上的提示。 */
  label: string;
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** 强制显示覆盖层（目录页与截图用）；不传时按实际拖放状态。 */
  dragging?: boolean;
  children?: ReactNode;
};

/**
 * 拖放 / 粘贴区域：拖入带文件的内容时显示覆盖层，松手交给 `onFiles`；区域内粘贴含文件时同样交给 `onFiles`，
 * 剪贴板里没有文字时阻止默认粘贴（同时有文字的，如从文档里复制，文字照常粘贴；不含文件的粘贴不受影响）。
 */
export function FileDrop({ label, onFiles, disabled, dragging: forced, children }: FileDropProps) {
  const [over, setDragging] = useState(false);
  const dragging = forced ?? over;
  /** dragenter / dragleave 在子元素间移动时成对触发：计数归零才算离开。 */
  const depth = useRef(0);

  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (disabled || !hasFiles(e.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    // 不论 types 如何都收起（拖放结束时浏览器给的 types 不一定可靠）
    reset();
    if (disabled || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length > 0) onFiles(files);
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    if (!Array.from(e.clipboardData.types ?? []).includes("text/plain")) e.preventDefault();
    onFiles(files);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 拖放 / 粘贴目标；键盘用户经 FileButton 选文件
    <div
      className="cb-file-drop"
      data-dragging={dragging ? "true" : undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={reset}
      onPaste={onPaste}
    >
      {children}
      {dragging ? (
        <div className="cb-file-drop-overlay" aria-hidden="true">
          {label}
        </div>
      ) : null}
    </div>
  );
}

export type FileButtonProps = {
  /** 按钮的可访问名称。 */
  label: string;
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
};

/** 选文件按钮：点击打开系统文件选择，选中后交给 `onFiles` 并清空（同一文件可再次选择）。 */
export function FileButton({
  label,
  onFiles,
  accept,
  multiple,
  disabled,
  icon = "+",
}: FileButtonProps) {
  const input = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) onFiles(files);
  };
  return (
    <>
      <IconButton
        label={label}
        icon={icon}
        disabled={disabled}
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        className="cb-file-input"
        type="file"
        tabIndex={-1}
        aria-hidden="true"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={onChange}
      />
    </>
  );
}

/** 本源路径解析用的占位源：解析后源不变才算本源路径。 */
const PLACEHOLDER_ORIGIN = "http://x.invalid";

/**
 * 附件地址是否安全：http(s) 绝对地址，或本源的绝对路径（单个 `/` 开头）。
 * 原串里有任何 ASCII 控制字符、空白或 `\` 一律不认（浏览器会删掉制表 / 换行，`/\t/evil` 会变成 `//evil`）；
 * `/` 开头的再按占位源解析，源变了（协议相对地址）也不认。`javascript:`、`data:` 与相对路径同样不认。
 */
export function isSafeAttachmentHref(href: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
  if (href === "" || /[\u0000-\u0020\u007f\\]/.test(href)) return false;
  if (href.startsWith("/")) {
    try {
      return new URL(href, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
    } catch {
      return false;
    }
  }
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 加上重试用的缓存参数 `retry=<n>`（n ≤ 0 时原样返回）。 */
function withRetry(href: string, retry: number): string {
  if (retry <= 0) return href;
  return `${href}${href.includes("?") ? "&" : "?"}retry=${retry}`;
}

export type AttachmentPreviewProps = {
  kind: "image" | "file";
  name: string;
  /** 打开 / 下载地址（http(s) 或本源路径）。 */
  href: string;
  /** 文件卡片的说明（如类型）。 */
  meta?: string;
  /** 图片加载失败时调用（调用方可刷新登录后递增 `retry` 重试）。 */
  onImageError?: () => void;
  /** 重试次数：大于 0 时图片地址加上缓存参数重新加载（链接地址不变）。 */
  retry?: number;
  /** 给了它时，不带修饰键的左键点击交给调用方打开（阻止默认打开），其余点击照常。 */
  onOpen?: (href: string) => void;
};

/** 消息里的附件：图片为缩略图，其他为文件卡片；都是新标签页打开的链接。 */
export function AttachmentPreview({
  kind,
  name,
  href,
  meta,
  onImageError,
  retry = 0,
  onOpen,
}: AttachmentPreviewProps) {
  if (!isSafeAttachmentHref(href)) {
    return (
      <span className="cb-attachment" data-kind="file">
        <span className="cb-attachment-glyph" aria-hidden="true">
          ▤
        </span>
        <span className="cb-attachment-name">{name}</span>
      </span>
    );
  }
  const onClick = onOpen
    ? (e: MouseEvent<HTMLAnchorElement>) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpen(href);
      }
    : undefined;
  if (kind === "image") {
    return (
      <a
        className="cb-attachment"
        data-kind="image"
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={name}
        onClick={onClick}
      >
        <img
          className="cb-attachment-thumb"
          src={withRetry(href, retry)}
          alt={name}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={onImageError}
        />
      </a>
    );
  }
  return (
    <a
      className="cb-attachment"
      data-kind="file"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={name}
      onClick={onClick}
    >
      <span className="cb-attachment-glyph" aria-hidden="true">
        ▤
      </span>
      <span className="cb-attachment-text">
        <span className="cb-attachment-name">{name}</span>
        {meta ? <span className="cb-attachment-meta">{meta}</span> : null}
      </span>
    </a>
  );
}
