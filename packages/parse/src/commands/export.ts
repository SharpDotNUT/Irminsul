import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { findCli, runCli } from "../anime-studio.ts";
import { WORK_PATHS, type Context } from "../context.ts";
import { resolveScanRoot } from "../genshin.ts";
import { log } from "../log.ts";
import { patternsForGroups, rules } from "../rules.ts";

export type ExportOptions = {
  input?: string;
  out?: string;
  map?: string;
  /** Named rule groups; defaults to every group in `rules.json`. */
  groups: string[];
  /** Extra regexes appended to the group patterns. */
  patterns: string[];
  /** Skip `--names` entirely and export every Texture2D in the map. */
  all: boolean;
  types: string[];
  exportType: string;
  groupAssets: string;
};

function countFiles(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(dir, entry.name));
    else total += 1;
  }
  return total;
}

export async function exportCommand(ctx: Context, options: ExportOptions): Promise<void> {
  const cli = findCli(ctx.workDir);
  const blocks = resolveScanRoot(options.input);
  const mapFile = resolve(options.map ?? join(ctx.workDir, WORK_PATHS.mapFile));
  if (!existsSync(mapFile)) {
    throw new Error(`asset map 不存在: ${mapFile}\n先运行: parse build_map`);
  }

  let namesArgs: string[] = [];
  let outArg: string;
  if (options.all) {
    log("已指定 --all：导出 map 中全部 Texture2D");
    outArg = resolve(options.out ?? "export");
  } else {
    const groups = options.groups.length > 0 ? options.groups : rules.default;
    const patterns = [...patternsForGroups(groups), ...options.patterns];
    if (patterns.length === 0) {
      throw new Error("没有任何导出规则：用 --group / --pattern 指定，或 --all 导出全部 Texture2D");
    }
    log(`规则组: ${groups.join(", ")}`);
    for (const name of groups) log(`  ${name}: ${rules.groups[name]!.patterns.join(" | ")}`);
    if (options.patterns.length > 0) log(`  附加正则: ${options.patterns.join(" | ")}`);
    log(`共 ${patterns.length} 条正则`);

    const namesFile = join(ctx.workDir, WORK_PATHS.namesFile);
    await writeFile(namesFile, `${patterns.join("\n")}\n`);
    namesArgs = ["--names", namesFile];
    outArg = resolve(options.out ?? "export");
  }

  const args = [
    blocks,
    outArg,
    "--game",
    ctx.game,
    // "AssetMap,Load" reads the existing map instead of rescanning every .blk.
    "--map_op",
    "AssetMap,Load",
    "--map_type",
    "MessagePack",
    "--map_name",
    mapFile,
    ...options.types.flatMap((type) => ["--types", type]),
    ...namesArgs,
    "--group_assets",
    options.groupAssets,
    "--export_type",
    options.exportType,
    ...(ctx.silent ? ["--silent"] : []),
  ];

  log(`导出到: ${outArg}`);
  await runCli(cli, ctx.workDir, args);

  if (existsSync(outArg)) log(`导出目录现有 ${countFiles(outArg)} 个文件: ${outArg}`);
}
