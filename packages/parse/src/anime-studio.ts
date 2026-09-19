import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { WORK_PATHS } from "./context.ts";
import { downloadTo, progressReporter, resolveArtifact } from "./download.ts";
import { log, warn } from "./log.ts";

export const CLI_EXE = "AnimeStudio.CLI.exe";

/** Upstream build to install: nightly.link serves the branch build, GitHub only its artifacts. */
const CLI_ARTIFACT = {
  repo: "Escartem/AnimeStudio",
  branch: "master",
  artifact: "AnimeStudio-net10",
} as const;

const CLI_NIGHTLY_URL = `https://nightly.link/${CLI_ARTIFACT.repo}/workflows/build/${CLI_ARTIFACT.branch}/${CLI_ARTIFACT.artifact}.zip`;

/**
 * Downloads the CLI archive into `<workDir>/downloads` and returns its path — verifying and
 * extracting it is the caller's job.
 *
 * Falls back to the latest successful GitHub Actions run's artifact when nightly.link is down;
 * artifact downloads are auth-only, hence the token requirement.
 */
export async function downloadCliArchive(workDir: string, url = CLI_NIGHTLY_URL): Promise<string> {
  const zipPath = join(workDir, WORK_PATHS.downloads, basename(new URL(url).pathname) || "anime-studio.zip");

  log(`下载 AnimeStudio: ${url}`);
  try {
    await downloadTo(url, zipPath, { onProgress: progressReporter() });
  } catch (error) {
    warn(`${url} 不可用（${(error as Error).message}）`);
    const fallback = await resolveArtifact(CLI_ARTIFACT);
    if (!fallback.token) {
      throw new Error(
        "GitHub Actions 构建产物只能通过 API 鉴权下载，请设置 GITHUB_TOKEN / GH_TOKEN，或先执行 gh auth login",
      );
    }
    log(`改用 GitHub Actions run ${fallback.runId} 的 ${CLI_ARTIFACT.artifact} 产物`);
    await downloadTo(fallback.url, zipPath, { token: fallback.token, onProgress: progressReporter() });
  }
  return zipPath;
}

/** Locates `AnimeStudio.CLI.exe` inside the work dir, tolerating one nesting level. */
export function findCli(workDir: string): string {
  const root = join(workDir, WORK_PATHS.animeStudio);
  const direct = join(root, CLI_EXE);
  if (existsSync(direct)) return direct;

  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = join(root, entry.name, CLI_EXE);
      if (existsSync(nested)) return nested;
    }
  }
  throw new Error(`未找到 ${CLI_EXE}（查找位置: ${root}），请先运行: parse init`);
}

export async function cliVersion(cli: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(cli, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.on("error", reject);
  child.on("close", (code) => {
    if (code === 0) resolve(out.trim());
    else reject(new Error(`${CLI_EXE} --version 退出码 ${code}`));
  });
  return promise;
}

/**
 * Runs the AnimeStudio CLI with stdio inherited.
 * Note: the CLI throws IndexOutOfRangeException when filters match nothing.
 */
export async function runCli(cli: string, cwd: string, args: string[]): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error(
      `AnimeStudio CLI 是 net10.0-windows 构建（依赖 libSkiaSharp.dll 等原生库），当前平台 ${process.platform} 无法运行`,
    );
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(cli, args, { cwd, stdio: "inherit" });
  child.on("error", (error) => reject(new Error(`无法启动 AnimeStudio CLI: ${error.message}`)));
  child.on("close", (code, signal) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(
      new Error(
        `AnimeStudio CLI 退出码 ${code ?? signal ?? "signal"}；` +
          `若日志以 IndexOutOfRangeException 结束，说明过滤条件没有命中任何资产`,
      ),
    );
  });
  return promise;
}
