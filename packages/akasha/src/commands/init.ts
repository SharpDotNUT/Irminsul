import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CLI_EXE, cliVersion, downloadCliArchive, findCli } from "../anime-studio.ts";
import { WORK_PATHS } from "../context.ts";
import { log } from "../log.ts";
import { trace } from "../timing.ts";
import { assertZipFile, extractZip } from "../zip.ts";

export async function initCommand(
  workDir: string,
  options: { url?: string; force?: boolean },
): Promise<void> {
  const installed = await trace("检查已安装的 CLI", () => {
    try {
      return findCli(workDir);
    } catch {
      return null;
    }
  });

  if (installed && !options.force) {
    log(`AnimeStudio 已安装: ${installed}`);
    const version = await trace("查询 CLI 版本", () => cliVersion(installed));
    log(`版本: ${version}（--force 可重新下载）`);
    return;
  }

  const zipPath = await trace("下载 AnimeStudio", () => downloadCliArchive(workDir, options.url));
  await trace("校验压缩包", () => assertZipFile(zipPath));

  const dest = join(workDir, WORK_PATHS.animeStudio);
  const { files, strippedRoot } = await trace("解压 AnimeStudio", async () => {
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    return extractZip(zipPath, dest);
  });
  log(`解压 ${files.length} 个文件到 ${dest}${strippedRoot ? `（去掉外层目录 ${strippedRoot}）` : ""}`);

  const cli = findCli(workDir);
  if (cli !== join(dest, CLI_EXE)) log(`注意: CLI 位于 ${cli}`);
  log(`AnimeStudio CLI 就绪: ${cli}`);
  log(`版本: ${await trace("查询 CLI 版本", () => cliVersion(cli))}`);
}
