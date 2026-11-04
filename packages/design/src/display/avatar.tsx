import { type ChangeEvent, useId, useRef, useState } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import { AVATAR_GRID, AVATAR_PRESET_IDS, AVATAR_PRESETS, type PresetId } from "./avatar-presets";
import { initialOf } from "./initial";
import { bitmapCells } from "./logo";

export {
  AVATAR_GRID,
  AVATAR_PRESET_IDS,
  AVATAR_PRESETS,
  type AvatarPreset,
  type PresetId,
} from "./avatar-presets";

/** The five avatar sizes (spec §6.30). */
export const AVATAR_SIZES = [16, 24, 28, 40, 64] as const;
export type AvatarSize = (typeof AVATAR_SIZES)[number];

/** An agent's avatar: a preset animal, an uploaded image, or none (the initial). */
export type AvatarValue = { kind: "preset"; id: PresetId } | { kind: "image"; src: string } | null;

/** The formats an upload accepts (agent profile design §2.3). */
export const AVATAR_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * A preset's paths at `size`: one path per palette token, the bitmap at the nearest whole pixel
 * unit to `size / 12`, centred by the viewBox; every size holds the whole drawing (no clipping).
 */
function presetDrawing(id: PresetId, size: AvatarSize) {
  const preset = AVATAR_PRESETS[id];
  const unit = Math.round(size / AVATAR_GRID);
  const off = (size - AVATAR_GRID * unit) / 2;
  const byToken = new Map<string, string>();
  for (const [cell, token] of Object.entries(preset.palette)) {
    byToken.set(token, (byToken.get(token) ?? "") + bitmapCells(preset.bitmap, unit, 0, cell));
  }
  return { viewBox: `${-off} ${-off} ${size} ${size}`, paths: [...byToken] };
}

/**
 * Avatar (spec §6.30): an agent's preset animal on its ground, its uploaded image, or the initial
 * square (an image that fails to load falls back to the initial). Decorative: the name is always
 * written next to it, so it is hidden from screen readers.
 */
export function Avatar({
  value,
  name,
  size,
  onImageError,
}: {
  value: AvatarValue;
  name: string;
  size: AvatarSize;
  /** Called once when an image avatar fails to load (it then draws the initial). */
  onImageError?: () => void;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const common = {
    className: "cb-avatar",
    "data-part": "avatar",
    "data-size": String(size),
    "aria-hidden": true,
  } as const;
  const preset = value?.kind === "preset" ? AVATAR_PRESETS[value.id] : undefined;
  if (value?.kind === "preset" && preset) {
    const { viewBox, paths } = presetDrawing(value.id, size);
    return (
      <span
        {...common}
        data-kind="preset"
        data-preset={value.id}
        style={{ background: `var(--cb-${preset.ground})` }}
      >
        <svg
          className="cb-avatar-art"
          width={size}
          height={size}
          viewBox={viewBox}
          shapeRendering="crispEdges"
          aria-hidden="true"
          focusable="false"
        >
          {paths.map(([token, d]) => (
            <path key={token} d={d} style={{ fill: `var(--cb-${token})` }} />
          ))}
        </svg>
      </span>
    );
  }
  if (value?.kind === "image" && failed !== value.src) {
    const src = value.src;
    return (
      <span {...common} data-kind="image">
        <img
          className="cb-avatar-art cb-avatar-image"
          src={src}
          alt=""
          onError={() => {
            setFailed(src);
            onImageError?.();
          }}
        />
      </span>
    );
  }
  return (
    <span {...common} data-kind="initial">
      {initialOf(name)}
    </span>
  );
}

export type AvatarPickerProps = {
  value: AvatarValue;
  onChange: (value: AvatarValue) => void;
  /** The chosen png, jpg or webp file; absent, the upload tile is disabled with its reason. */
  onUpload?: (file: File) => void;
  /** Why uploading is off (shown under the tiles when `onUpload` is absent). */
  uploadOffReason?: string;
  /** The group's name; default 「头像」 / "Avatar". */
  label?: string;
  /** Every tile is disabled (the owner form is saving); the value stays shown. */
  disabled?: boolean;
};

/**
 * AvatarPicker (spec §6.30): the ten presets as one radio group of 40 px tiles, then an upload
 * tile, which shows the uploaded image when that is the avatar. Without `onUpload` the upload tile
 * is disabled and the reason is written under the tiles.
 */
export function AvatarPicker({
  value,
  onChange,
  onUpload,
  uploadOffReason,
  label,
  disabled = false,
}: AvatarPickerProps) {
  const t = useDesignT();
  const name = useId();
  const reasonId = useId();
  const input = useRef<HTMLInputElement>(null);
  // an uploaded image that fails to load shows the upload icon, never an empty initial
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) onUpload?.(file);
  };
  const image = value?.kind === "image";
  return (
    <div className="cb-avatar-picker" data-part="avatar-picker">
      <div className="cb-avatar-picker-tiles">
        <div
          className="cb-avatar-picker-group"
          role="radiogroup"
          aria-label={label ?? t("avatar.label")}
        >
          {AVATAR_PRESET_IDS.map((id) => {
            const checked = value?.kind === "preset" && value.id === id;
            const presetName = t(`avatar.preset.${id}`);
            return (
              <label
                key={id}
                className="cb-avatar-tile"
                data-part="avatar-tile"
                data-state={checked ? "checked" : "unchecked"}
              >
                <input
                  className="cb-avatar-radio"
                  type="radio"
                  name={name}
                  value={id}
                  checked={checked}
                  disabled={disabled}
                  aria-label={presetName}
                  onChange={() => onChange({ kind: "preset", id })}
                />
                <Avatar value={{ kind: "preset", id }} name={presetName} size={40} />
              </label>
            );
          })}
        </div>
        <button
          type="button"
          className="cb-avatar-tile"
          data-part="avatar-upload"
          data-state={image ? "checked" : "unchecked"}
          aria-label={t("avatar.upload")}
          aria-describedby={onUpload ? undefined : reasonId}
          disabled={!onUpload || disabled}
          onClick={() => input.current?.click()}
        >
          {image && failedSrc !== value.src ? (
            <Avatar value={value} name="" size={40} onImageError={() => setFailedSrc(value.src)} />
          ) : (
            <Icon name="upload" size={16} />
          )}
        </button>
      </div>
      {onUpload ? (
        <input
          ref={input}
          className="cb-file-input"
          type="file"
          tabIndex={-1}
          aria-hidden="true"
          accept={AVATAR_UPLOAD_ACCEPT}
          onChange={onFile}
        />
      ) : (
        <p id={reasonId} className="cb-avatar-picker-reason" data-part="avatar-upload-reason">
          {uploadOffReason ?? t("avatar.uploadOff")}
        </p>
      )}
    </div>
  );
}
