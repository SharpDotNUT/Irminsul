import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WORK_PATHS, findCli, runCli } from "../anime-studio.ts";
import type { Context } from "../context.ts";
import { resolveScanRoot } from "../genshin.ts";
import { log } from "../log.ts";

export type BuildMapOptions = {
  input?: string;
  types: string[];
  aiFile?: string;
};

export async function buildMapCommand(ctx: Context, options: BuildMapOptions): Promise<void> {
  const cli = findCli(ctx.workDir);
  const blocks = resolveScanRoot(options.input);
  const mapDir = join(ctx.workDir, WORK_PATHS.maps);
  const mapFile = join(ctx.workDir, WORK_PATHS.mapFile);

  await mkdir(mapDir, { recursive: true });
  if (existsSync(mapFile)) log(`已有 map 会被覆盖: ${mapFile}`);

  const args = [
    blocks,
    // Output dir is relative to the CLI's cwd (the work dir), default map name is assets_map.
    WORK_PATHS.maps,
    "--game",
    ctx.game,
    "--map_op",
    "AssetMap",
    "--map_type",
    "MessagePack",
    // Comma-separated values are NOT split by the CLI; each type needs its own flag.
    ...options.types.flatMap((type) => ["--types", type]),
    ...(options.aiFile ? ["--ai_file", resolve(options.aiFile)] : []),
    ...(ctx.silent ? ["--silent"] : []),
  ];

  log(`扫描 blocks: ${blocks}`);
  log(`构建 asset map: ${mapFile}（types: ${options.types.join(", ")}）`);
  await runCli(cli, ctx.workDir, args);

  if (!existsSync(mapFile)) throw new Error(`AnimeStudio 未生成 ${mapFile}`);
  log(`asset map 完成: ${mapFile} (${(statSync(mapFile).size / 1024 / 1024).toFixed(1)} MiB)`);
}
