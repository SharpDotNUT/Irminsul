import { existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { CLI_EXE, WORK_PATHS, cliVersion, findCli } from "../anime-studio.ts";
import { ARTIFACT_NAME, NIGHTLY_URL, downloadTo, progressReporter, resolveLatestArtifact } from "../download.ts";
import { log, warn } from "../log.ts";
import { extractZip } from "../zip.ts";

const ZIP_MAGIC = "PK\u0003\u0004";

/** GitHub answers expired/missing artifacts with an HTML/JSON body; fail early instead of extracting garbage. */
async function assertZip(zipPath: string): Promise<void> {
  const handle = await open(zipPath, "r");
  try {
    const header = Buffer.alloc(4);
    await handle.read(header, 0, 4, 0);
    if (header.toString("latin1") !== ZIP_MAGIC) {
      throw new Error(`${zipPath} 不是 zip 文件（下载内容可能是一个错误页）`);
    }
  } finally {
    await handle.close();
  }
}

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

  const url = options.url ?? NIGHTLY_URL;
  const zipPath = join(workDir, WORK_PATHS.downloads, basename(new URL(url).pathname) || "anime-studio.zip");

  log(`下载 AnimeStudio: ${url}`);
  try {
    await downloadTo(url, zipPath, { onProgress: progressReporter() });
  } catch (error) {
    warn(`${url} 不可用（${(error as Error).message}）`);
    const fallback = await resolveLatestArtifact();
    if (!fallback.token) {
      throw new Error(
        "GitHub Actions 构建产物只能通过 API 鉴权下载，请设置 GITHUB_TOKEN / GH_TOKEN，或先执行 gh auth login",
      );
    }
    log(`改用 GitHub Actions run ${fallback.runId} 的 ${ARTIFACT_NAME} 产物`);
    await downloadTo(fallback.url, zipPath, { token: fallback.token, onProgress: progressReporter() });
  }
  await assertZip(zipPath);

  const dest = join(workDir, WORK_PATHS.animeStudio);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const { files, strippedRoot } = await extractZip(zipPath, dest);
  log(`解压 ${files.length} 个文件到 ${dest}${strippedRoot ? `（去掉外层目录 ${strippedRoot}）` : ""}`);

  const cli = findCli(workDir);
  if (!existsSync(join(dest, CLI_EXE)) && cli !== join(dest, CLI_EXE)) log(`注意: CLI 位于 ${cli}`);
  log(`AnimeStudio CLI 就绪: ${cli}`);
  log(`版本: ${await cliVersion(cli)}`);
}
