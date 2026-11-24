import type { ObjectStore } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { isTextArtifactType } from "../conversations/artifacts.js";
import { type FileOutput, previewKind, trimUtf8 } from "../conversations/files.js";
import { ApiError } from "../errors.js";
import { StorageService } from "../storage/storage.service.js";
import { contentTypeFor } from "../tools/builtins/sandbox/deliver.js";
import { readSkillFile, SkillIntegrityError } from "../tools/builtins/skill-load.js";
import { SkillsService } from "./skills.service.js";
import { skillFileStore } from "./usable.js";

/** One file of a skill version, as `GET /skills/:id/files` lists it. */
export interface SkillFileEntry {
  path: string;
  size: number;
  /** By the file's extension (the kernel's lookup; unknown: `application/octet-stream`). */
  contentType: string;
  /** The built-in preview kind, the rule of the conversation file list. */
  previewable: FileOutput["previewable"];
}

/** `GET /skills/:id/files`: the files of one version of the skill. */
export interface SkillFileList {
  version: number;
  files: SkillFileEntry[];
}

/**
 * A skill file resolved for a read (kernel-internal: the store and key never reach a client or an
 * extension). Read it with {@link SkillFiles.read}, which checks size and sha256.
 */
export interface ResolvedSkillFile {
  store: ObjectStore;
  key: string;
  path: string;
  version: number;
  size: number;
  sha256: string;
  contentType: string;
}

/** The bytes of a skill file, at most the asked limit. */
export interface SkillFileBytes {
  file: ResolvedSkillFile;
  body: Buffer;
  /** The file is longer than `body`. */
  truncated: boolean;
}

const fileNotFound = () => new ApiError("skill.file_not_found", "Skill file not found");

/** Whether `path` could never be a manifest path (absolute, `.` / `..` / empty segments). */
const unsafePath = (path: string): boolean =>
  path.startsWith("/") ||
  path.includes("\\") ||
  path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");

/**
 * Read-only access to a skill version's files (skill file browser spec, "Kernel"). The skill is
 * the one `GET /skills/:id` shows the org ({@link SkillsService.resolve}: its own skill, or a
 * platform skill on in the org; otherwise `skill.not_found`). A file is addressed only by a path of
 * that version's manifest, so no storage key is ever built from input; an unknown version or path
 * is `skill.file_not_found`. Every read checks the object against the manifest (size, sha256, as
 * the Skill tool does): missing or different is 409 `skill.file_changed`.
 */
@Injectable()
export class SkillFiles {
  constructor(
    @Inject(SkillsService) private readonly skills: SkillsService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** The files of version `version` of the skill (default: its current version). */
  async list(orgId: string, skillId: string, version?: number): Promise<SkillFileList> {
    const v = await this.version(orgId, skillId, version);
    return {
      version: v.version,
      files: v.manifest.files.map((f) => {
        const contentType = contentTypeFor(f.path);
        return { path: f.path, size: f.size, contentType, previewable: previewKind(contentType) };
      }),
    };
  }

  /**
   * Where file `path` of version `version` (default: current) of the skill lives, with its manifest
   * size and sha256. Visibility as {@link list}; an unknown version or a path not in the manifest →
   * `skill.file_not_found` (nothing is read).
   */
  async resolve(
    orgId: string,
    skillId: string,
    version: number | undefined,
    path: string,
  ): Promise<ResolvedSkillFile> {
    const v = await this.version(orgId, skillId, version);
    // only an exact manifest path; the shape check is a second guard, manifests never hold such
    const entry = unsafePath(path) ? undefined : v.manifest.files.find((f) => f.path === path);
    if (!entry) throw fileNotFound();
    const { store, prefix } = skillFileStore(this.storage, orgId, v.object_prefix);
    return {
      store,
      key: `${prefix}${entry.path}`,
      path: entry.path,
      version: v.version,
      size: entry.size,
      sha256: entry.sha256,
      contentType: contentTypeFor(entry.path),
    };
  }

  /**
   * The bytes of a skill file, verified against its manifest entry (409 `skill.file_changed` when
   * the object is missing or differs), cut to `limit` bytes when given (a text file is never cut
   * inside a UTF-8 character).
   */
  async read(
    orgId: string,
    skillId: string,
    version: number | undefined,
    path: string,
    limit?: number,
  ): Promise<SkillFileBytes> {
    const file = await this.resolve(orgId, skillId, version, path);
    let bytes: Uint8Array;
    try {
      bytes = await readSkillFile(file.store, file.key, {
        path: file.path,
        size: file.size,
        sha256: file.sha256,
      });
    } catch (err) {
      if (err instanceof SkillIntegrityError) {
        throw new ApiError(
          "skill.file_changed",
          "The stored skill file no longer matches its version; upload the skill again",
        );
      }
      throw err;
    }
    let body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const truncated = limit !== undefined && body.byteLength > limit;
    if (truncated) {
      body = body.subarray(0, limit);
      if (isTextArtifactType(file.contentType)) body = trimUtf8(body);
    }
    return { file, body, truncated };
  }

  private async version(orgId: string, skillId: string, version: number | undefined) {
    const { summary, versions } = await this.skills.resolve(orgId, skillId);
    const want = version ?? summary.currentVersion;
    const v = versions.find((x) => x.version === want);
    if (!v) throw fileNotFound();
    return v;
  }
}
