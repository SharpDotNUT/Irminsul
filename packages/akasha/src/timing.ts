import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORK_PATHS } from "./context.ts";
import { log, setLogSink, warn } from "./log.ts";

/**
 * 一次 `akasha <command>` 运行的耗时跟踪：
 * 每个步骤结束时打印一行（`12.34s  下载 AnimeStudio`）并落盘，结束再汇总；
 * 运行期间的 `log`/`warn` 输出会一起写进 `<workDir>/logs/<command>-<时间>.log`。
 * 上游 CLI 自己的进度只看得到它的整段耗时 —— 子进程的 stdout 是直通的，这里不中转。
 */

type Step = { label: string; ms: number; ok: boolean };

const steps: Step[] = [];
let logFile: string | null = null;
let runStart = 0;
let peakRss = 0;

/** `<1s` 用毫秒、`<1min` 用秒、更长用 `分+秒` —— 各量级都约四位有效数字，便于纵向比较。 */
function stepLine(label: string, ms: number, ok: boolean): string {
  const duration =
    ms < 1000
      ? `${Math.round(ms)}ms`
      : ms < 60_000
        ? `${(ms / 1000).toFixed(2)}s`
        : `${Math.floor(ms / 60_000)}m${((ms % 60_000) / 1000).toFixed(1)}s`;
  return `${duration.padStart(8)}  ${label}${ok ? "" : "  [失败]"}`;
}

/** 日志文件名用的本地时间戳（`20260929-153012`）。 */
function timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 日志写入失败（磁盘满、目录只读）不能拖垮命令本身，报一次警告后就不再记。 */
function sink(text: string): void {
  if (logFile === null) return;
  try {
    appendFileSync(logFile, `${text}\n`);
  } catch (error) {
    logFile = null;
    warn(`运行日志写入失败，本次运行不再记录: ${(error as Error).message}`);
  }
}

/** 开始跟踪：建 `<workDir>/logs/<command>-<时间>.log`、写头，并把之后的输出都记进去。 */
export function startTrace(command: string, argv: string[], workDir: string): void {
  steps.length = 0;
  runStart = performance.now();
  peakRss = process.memoryUsage.rss();

  try {
    const dir = join(workDir, WORK_PATHS.logs);
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, `${command}-${timestamp(new Date())}.log`);
    writeFileSync(
      logFile,
      [
        `=== akasha ${command} ===`,
        `开始: ${new Date().toISOString()}`,
        `命令行: akasha ${argv.join(" ")}`,
        `工作目录: ${workDir}`,
        `运行时: bun ${process.versions.bun ?? "?"} / node ${process.versions.node} / ${process.platform} ${process.arch}`,
        "",
      ].join("\n"),
    );
  } catch (error) {
    logFile = null;
    warn(`无法创建运行日志（${join(workDir, WORK_PATHS.logs)}）: ${(error as Error).message}`);
  }
  setLogSink(sink);
}

function record(label: string, ms: number, ok: boolean): void {
  peakRss = Math.max(peakRss, process.memoryUsage.rss());
  steps.push({ label, ms, ok });
  log(stepLine(label, ms, ok));
}

/** 跑一步并记录耗时；成功与否都记录，异常照常抛出。 */
export async function trace<T>(label: string, run: () => T | Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await run();
    record(label, performance.now() - started, true);
    return result;
  } catch (error) {
    record(label, performance.now() - started, false);
    throw error;
  }
}

/** 结束跟踪：逐行回放每一步、合计与本进程峰值内存，并在最后写下日志路径。 */
export function finishTrace(error?: unknown): void {
  const total = performance.now() - runStart;
  const failed = error !== undefined;
  // 汇总标题保持单行，多行错误的换行折成空格（完整原文仍由顶层 `error:` 打印）。
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(/\s*\n\s*/g, " ");

  log(failed ? `耗时统计（失败: ${message}）:` : "耗时统计:");
  for (const step of steps) log(stepLine(step.label, step.ms, step.ok));
  log(`${stepLine("合计", total, !failed)}  ·  本进程峰值内存 ${(peakRss / 1024 / 1024).toFixed(0)} MiB`);
  if (logFile !== null) log(`日志: ${logFile}`);
  setLogSink(null);
}
