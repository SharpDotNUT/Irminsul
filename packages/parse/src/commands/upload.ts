import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { WORK_PATHS, type Context } from "../context.ts";
import { log } from "../log.ts";
import { createS3 } from "../s3.ts";

export type UploadOptions = {
  /** emoji 产物目录（`emoji.json` + `texts/`），默认 `<workDir>/emoji`。 */
  emojiDir?: string;
  /** 贴图目录，默认 `export`（与 `parse export --out` 的默认值一致）。 */
  imagesDir?: string;
  /** 远端前缀（首尾斜杠会被去掉），默认 `Static/GI`。 */
  prefix: string;
  /** 重传已存在且大小相同的对象。 */
  force: boolean;
};

/** 远端分类：文本/JSON 与贴图分开，下游可按类型设缓存策略。 */
const FORMATTED = "formatted";
const BINARY = "binary";

/** 单次 S3 往返以百毫秒计，串行传 900 个文件太慢，保持少量并发就够了。 */
const UPLOAD_CONCURRENCY = 12;

/** 递归收集目录下的文件，返回相对 `root` 的 posix 路径（远端 key 用 `/`）。 */
function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(relative(root, full).replaceAll(sep, "/"));
    }
  };
  visit(root);
  return files.sort();
}

export async function uploadCommand(ctx: Context, options: UploadOptions): Promise<void> {
  const prefix = options.prefix.replace(/^\/+|\/+$/g, "");
  if (prefix.length === 0) throw new Error("--prefix 不能为空");

  const sources = [
    {
      dir: resolve(options.emojiDir ?? join(ctx.workDir, WORK_PATHS.emoji)),
      category: FORMATTED,
      hint: "parse emoji",
    },
    {
      dir: resolve(options.imagesDir ?? "export"),
      category: BINARY,
      hint: "parse export --group emotion-icon --group emotion-tag-icon --out <目录>",
    },
  ];

  const entries: { key: string; path: string; size: number }[] = [];
  for (const source of sources) {
    if (!existsSync(source.dir)) {
      throw new Error(`目录不存在: ${source.dir}\n请先运行: ${source.hint}`);
    }
    for (const relativePath of walkFiles(source.dir)) {
      const path = join(source.dir, relativePath);
      entries.push({ key: `${prefix}/${source.category}/${relativePath}`, path, size: statSync(path).size });
    }
  }
  if (entries.length === 0) {
    log(`没有文件可上传（${sources.map((source) => source.dir).join(", ")}）`);
    return;
  }

  const s3 = createS3();
  log(`读取远端列表: s3://${s3.bucket}/${prefix}/`);
  const remote = await s3.listKeys(`${prefix}/`);

  const pending = entries.filter((entry) => options.force || remote.get(entry.key) !== entry.size);
  const skipped = entries.length - pending.length;
  let uploaded = 0;
  let bytes = 0;
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, async () => {
    for (let entry = pending.shift(); entry !== undefined; entry = pending.shift()) {
      await s3.upload(entry.key, entry.path);
      uploaded += 1;
      bytes += entry.size;
      log(`上传: ${entry.key}`);
    }
  });
  await Promise.all(workers);

  log(`跳过 ${skipped} 个已存在且大小相同的对象（--force 可重传）`);
  log(`上传完成: ${uploaded} 个对象 / ${(bytes / 1024 / 1024).toFixed(1)} MiB -> s3://${s3.bucket}/${prefix}/`);
}
