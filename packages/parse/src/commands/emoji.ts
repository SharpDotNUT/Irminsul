import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { WORK_PATHS } from "../anime-studio.ts";
import type { Context } from "../context.ts";
import { downloadTo, progressReporter } from "../download.ts";
import {
  DATA_REPO,
  EMOJI_FILE,
  EMOJI_SET_FILE,
  TEXT_MAP_LANGS,
  buildTexts,
  dataUrl,
  mergeConfigData,
  mergeTextMaps,
  textMapFile,
} from "../emoji.ts";
import { log, warn } from "../log.ts";

export type EmojiOptions = {
  /** 需要解析的语言（`resolveLangs` 的结果，空即全部）。 */
  langs: string[];
  /** 产物目录（`emoji.json` + `texts/`），默认 `<workDir>/emoji`。 */
  out?: string;
  /** 重新下载（默认复用 `.parse/dimbreath/` 的缓存）。 */
  force: boolean;
};

const CONFIG_FILE = "emoji.json";
const TEXTS_DIR = "texts";

/** 先写 `.part` 再改名：中断不会留下半截文件被当成有效缓存。 */
async function downloadCached(url: string, dest: string, force: boolean): Promise<void> {
  if (!force && existsSync(dest)) {
    log(`使用缓存: ${dest}（--force 可重新下载）`);
    return;
  }
  log(`下载: ${url}`);
  const part = `${dest}.part`;
  await downloadTo(url, part, { onProgress: progressReporter() });
  await rename(part, dest);
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} 不是合法 JSON（可能下载不完整），请加 --force 重新下载: ${(error as Error).message}`);
  }
}

export async function emojiCommand(ctx: Context, options: EmojiOptions): Promise<void> {
  const cacheDir = join(ctx.workDir, WORK_PATHS.dimbreath);
  await mkdir(cacheDir, { recursive: true });

  const emojiFile = join(cacheDir, basename(EMOJI_FILE));
  const setFile = join(cacheDir, basename(EMOJI_SET_FILE));
  await downloadCached(dataUrl(EMOJI_FILE), emojiFile, options.force);
  await downloadCached(dataUrl(EMOJI_SET_FILE), setFile, options.force);
  const { data, hashes, orphanSetIDs } = mergeConfigData(
    options.langs,
    await readJson(emojiFile),
    await readJson(setFile),
  );

  // 只保留配置引用到的 hash：全语言 TextMap 合计约 350MB，整份解析后不能同时留在内存里。
  log(`语言: ${options.langs.join(", ")}（${hashes.size} 个 hash 待解析）`);
  const texts: Record<string, Map<string, string>> = {};
  for (const lang of options.langs) {
    const parts: unknown[] = [];
    for (const suffix of TEXT_MAP_LANGS[lang]!) {
      const file = join(cacheDir, `TextMap_Medium${suffix}.json`);
      await downloadCached(dataUrl(textMapFile(suffix)), file, options.force);
      parts.push(await readJson(file));
    }
    texts[lang] = mergeTextMaps(parts, hashes);
    log(`  ${lang}: 合并 ${parts.length} 个分片 -> ${texts[lang].size}/${hashes.size} 条文案`);
  }
  const { byLang, missing, incomplete } = buildTexts(hashes, options.langs, texts);

  // 原始缓存留在 <workDir>/dimbreath/，产物单独放 <out>/，不再混在一起。
  const outDir = resolve(options.out ?? join(ctx.workDir, WORK_PATHS.emoji));
  const textsDir = join(outDir, TEXTS_DIR);
  await mkdir(textsDir, { recursive: true });
  const configFile = join(outDir, CONFIG_FILE);
  await writeFile(configFile, `${JSON.stringify(data, null, 2)}\n`);
  for (const lang of options.langs) {
    await writeFile(join(textsDir, `${lang}.json`), `${JSON.stringify(byLang[lang], null, 2)}\n`);
  }

  const emojis = data.sets.reduce((total, set) => total + set.emojis.length, 0);
  log(`数据源: ${DATA_REPO}（${data.langs.length} 种语言）`);
  log(`Config Data 合并: ${data.sets.length} 个表情包 / ${emojis} 个表情，文案仍按 hash 引用 -> ${configFile}`);
  log(`文案表: ${options.langs.length} 个语言文件（${hashes.size} 个 hash, ${hashes.size * options.langs.length - missing} 条文案）-> ${textsDir}`);
  if (missing > 0) {
    const iconByHash = new Map<string, string>();
    for (const set of data.sets) {
      if (set.nameTextMapHash !== null) iconByHash.set(String(set.nameTextMapHash), set.icon);
      for (const item of set.emojis) {
        if (item.contentTextMapHash !== null) iconByHash.set(String(item.contentTextMapHash), item.icon);
      }
    }
    const icons = incomplete.map((hash) => iconByHash.get(hash) ?? hash);
    warn(
      `${missing} 处文案缺失（${icons.length} 个 icon: ${icons.slice(0, 6).join(", ")}${icons.length > 6 ? ", …" : ""}），` +
        `文案表里缺的语言不出键`,
    );
  }
  if (orphanSetIDs.length > 0) warn(`有表情引用了不存在的 setID: ${orphanSetIDs.join(", ")}（未写入输出）`);
  log(`提示: 贴图用 parse export --group emotion-icon --group emotion-tag-icon 导出`);
}
