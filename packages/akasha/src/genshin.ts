import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** Environment variable holding the Genshin Impact install folder. */
export const GENSHIN_DIR_ENV = "GENSHIN_DIR";

const DATA_DIR_PREFERENCE = ["YuanShen_Data", "GenshinImpact_Data", "GenshinImpact_Data_cn"];

/** `*_Data` folders, most likely candidate first. */
function dataDirs(gameDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(gameDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.endsWith("_Data"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const ranked = names.map((name) => {
    const index = DATA_DIR_PREFERENCE.indexOf(name);
    return { name, rank: index === -1 ? DATA_DIR_PREFERENCE.length : index };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return ranked.map((entry) => entry.name);
}

/** Every place `blocks` could live under a scan root, in resolution order. */
function blocksCandidates(root: string): string[] {
  const suffix = join("StreamingAssets", "AssetBundles", "blocks");
  return [
    ...(basename(root).toLowerCase() === "blocks" ? [root] : []),
    join(root, suffix),
    join(root, "AssetBundles", "blocks"),
    join(root, "blocks"),
    ...dataDirs(root).map((name) => join(root, name, suffix)),
  ];
}

/**
 * Resolves the AnimeStudio input path: a `.blk` file or the folder holding them.
 *
 * `--input` is taken literally when no known Genshin layout is found under it (so a single
 * `blocks/01` subset works), while `GENSHIN_DIR` must resolve — otherwise the env var is
 * almost certainly wrong. Accepts the install root, any `*_Data` folder, `AssetBundles` or `blocks`.
 */
export function resolveScanRoot(cliInput?: string): string {
  const raw = cliInput ?? process.env[GENSHIN_DIR_ENV];
  if (!raw) {
    throw new Error(
      `未提供游戏目录：请设置环境变量 ${GENSHIN_DIR_ENV}（原神游戏文件夹），或用 --input 指定目录`,
    );
  }

  const target = resolve(raw);
  if (!existsSync(target)) {
    throw new Error(`${cliInput ? "--input" : GENSHIN_DIR_ENV} 指向的路径不存在: ${target}`);
  }
  if (!statSync(target).isDirectory()) return target;

  const candidates = blocksCandidates(target);
  const hit = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isDirectory());
  if (hit) return hit;
  if (cliInput) return target;

  throw new Error(
    `在 ${target} 下找不到 StreamingAssets/AssetBundles/blocks（已尝试:\n  ${candidates.join("\n  ")}）\n` +
      `${GENSHIN_DIR_ENV} 应指向原神游戏文件夹（含 YuanShen.exe / GenshinImpact_Data 的那一层）`,
  );
}
