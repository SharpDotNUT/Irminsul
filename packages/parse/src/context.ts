import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORK_DIR_ENV = "PARSE_WORK_DIR";
/** Folder name, relative to the project root, holding the CLI build, the asset map and names.txt. */
export const WORK_DIR_NAME = ".parse";

/** Paths inside the work dir, relative to its root. */
export const WORK_PATHS = {
  animeStudio: "anime-studio",
  maps: "maps",
  mapFile: "maps/assets_map.map",
  namesFile: "names.txt",
  /** `parse export` 的默认输出目录（可复用产物，不要随意删除或重导）。 */
  export: "export",
  downloads: "downloads",
  /** DimbreathBot/AnimeGameData 原始 JSON 缓存。 */
  dimbreath: "dimbreath",
  /** `parse emoji` 的产物（合并后的 config + 每语言一份文案表）。 */
  emoji: "emoji",
} as const;

export type Context = {
  /** Directory holding the extracted CLI, the asset map and generated rule lists. */
  workDir: string;
  /** AnimeStudio `--game` value. */
  game: string;
  silent: boolean;
};

/** Project root: nearest ancestor of this package carrying a `pnpm-workspace.yaml`, else `<root>/packages/parse/../..`. */
function projectRoot(): string {
  // context.ts lives at <root>/packages/parse/src/.
  const moduleRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  let dir = moduleRoot;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return moduleRoot;
    dir = parent;
  }
  return dir;
}

/**
 * `--work-dir` > `PARSE_WORK_DIR` > `<project root>/.parse` (gitignored).
 * Deriving the default from this module keeps it independent of the current working directory,
 * so `parse` reaches the same map and CLI no matter where it is invoked from.
 */
export function resolveWorkDir(explicit?: string): string {
  const raw = explicit ?? process.env[WORK_DIR_ENV];
  if (raw) return resolve(raw);
  return join(projectRoot(), WORK_DIR_NAME);
}
