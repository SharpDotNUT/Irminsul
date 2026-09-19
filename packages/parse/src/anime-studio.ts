import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Paths inside the work dir, relative to its root. */
export const WORK_PATHS = {
  animeStudio: "anime-studio",
  maps: "maps",
  mapFile: "maps/assets_map.map",
  namesFile: "names.txt",
  downloads: "downloads",
} as const;

export const CLI_EXE = "AnimeStudio.CLI.exe";

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
