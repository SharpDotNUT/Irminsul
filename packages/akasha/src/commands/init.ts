import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CLI_EXE, cliVersion, downloadCliArchive, findCli } from "../anime-studio.ts";
import { WORK_PATHS } from "../context.ts";
import { log } from "../log.ts";
import { assertZipFile, extractZip } from "../zip.ts";

export async function initCommand(
  workDir: string,
  options: { url?: string; force?: boolean },
): Promise<void> {
  let installed: string | null = null;
  try {
    installed = findCli(workDir);
  } catch {
    installed = null;
  }

  if (installed && !options.force) {
    log(`AnimeStudio 已安装: ${installed}`);
    log(`版本: ${await cliVersion(installed)}（--force 可重新下载）`);
    return;
  }

  const zipPath = await downloadCliArchive(workDir, options.url);
  await assertZipFile(zipPath);

  const dest = join(workDir, WORK_PATHS.animeStudio);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const { files, strippedRoot } = await extractZip(zipPath, dest);
  log(`解压 ${files.length} 个文件到 ${dest}${strippedRoot ? `（去掉外层目录 ${strippedRoot}）` : ""}`);

  const cli = findCli(workDir);
  if (cli !== join(dest, CLI_EXE)) log(`注意: CLI 位于 ${cli}`);
  log(`AnimeStudio CLI 就绪: ${cli}`);
  log(`版本: ${await cliVersion(cli)}`);
}
