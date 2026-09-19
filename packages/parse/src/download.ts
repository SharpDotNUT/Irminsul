import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "./log.ts";

const API_ROOT = "https://api.github.com";
const USER_AGENT = "irminsul-parse";

type WorkflowRun = { id: number; head_sha: string };
type Artifact = { name: string; expired: boolean; archive_download_url: string };

/** One GitHub Actions artifact to fall back to: repository, branch and artifact name. */
export type ArtifactSource = { repo: string; branch: string; artifact: string };

async function githubApi(path: string, token?: string): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": USER_AGENT,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${path} -> ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/** `GITHUB_TOKEN` / `GH_TOKEN`, else the `gh` CLI login. Artifact downloads are auth-only. */
function githubToken(): string | undefined {
  const fromEnv = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Latest successful `source.branch` run's non-expired `source.artifact`, ready to download. */
export async function resolveArtifact(
  source: ArtifactSource,
): Promise<{ url: string; token: string | undefined; runId: number }> {
  const token = githubToken();
  const runs = (await githubApi(
    `/repos/${source.repo}/actions/runs?branch=${source.branch}&status=success&per_page=1`,
    token,
  )) as { workflow_runs?: WorkflowRun[] };
  const run = runs.workflow_runs?.[0];
  if (!run) throw new Error(`${source.repo} 的 ${source.branch} 分支没有成功的 workflow run`);

  const artifacts = (await githubApi(
    `/repos/${source.repo}/actions/runs/${run.id}/artifacts`,
    token,
  )) as { artifacts?: Artifact[] };
  const available = artifacts.artifacts ?? [];
  const artifact = available.find((entry) => entry.name === source.artifact && !entry.expired);
  if (!artifact) {
    const names = available.map((entry) => entry.name).join(", ") || "(无)";
    throw new Error(`run ${run.id} 没有可用的 ${source.artifact} 构建产物，现有: ${names}`);
  }
  return { url: artifact.archive_download_url, token, runId: run.id };
}

/**
 * Fetches a download URL, following the redirect by hand: the signed CDN target must not
 * receive the GitHub token, and cross-origin redirects may drop it anyway.
 */
async function openStream(url: string, token?: string): Promise<Response> {
  const headers = {
    "user-agent": USER_AGENT,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const initial = await fetch(url, { redirect: "manual", headers });
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get("location");
    if (!location) throw new Error(`下载重定向缺少 Location: ${url}`);
    const signed = await fetch(location, { redirect: "follow", headers: { "user-agent": USER_AGENT } });
    if (!signed.ok) throw new Error(`下载失败 ${signed.status} ${signed.statusText}: ${location}`);
    return signed;
  }
  if (!initial.ok) throw new Error(`下载失败 ${initial.status} ${initial.statusText}: ${url}`);
  return initial;
}

const PROGRESS_STEP = 8 * 1024 * 1024;

/** Throttled MiB progress lines for `downloadTo`. */
export function progressReporter(): (received: number, total: number | null) => void {
  let reported = 0;
  return (received, total) => {
    if (received - reported < PROGRESS_STEP && received !== total) return;
    reported = received;
    const mib = (received / 1024 / 1024).toFixed(1);
    log(total ? `  ${mib} / ${(total / 1024 / 1024).toFixed(1)} MiB` : `  ${mib} MiB`);
  };
}

export async function downloadTo(
  url: string,
  dest: string,
  options: { token?: string; onProgress?: (received: number, total: number | null) => void } = {},
): Promise<void> {
  const response = await openStream(url, options.token);
  if (!response.body) throw new Error(`下载响应没有内容: ${url}`);

  await mkdir(dirname(dest), { recursive: true });
  const handle = await open(dest, "w");
  try {
    // gzip/br responses report the compressed content-length; the reader yields decoded bytes.
    const total =
      response.headers.get("content-encoding") !== null
        ? null
        : Number(response.headers.get("content-length")) || null;
    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await handle.write(value);
      received += value.byteLength;
      options.onProgress?.(received, total);
    }
  } finally {
    await handle.close();
  }
}

/** 复用已下载的缓存；先写 `.part` 再改名，中断不会留下半截文件被当成有效缓存。 */
export async function downloadCached(url: string, dest: string, force: boolean): Promise<void> {
  if (!force && existsSync(dest)) {
    log(`使用缓存: ${dest}（--force 可重新下载）`);
    return;
  }
  log(`下载: ${url}`);
  const part = `${dest}.part`;
  await downloadTo(url, part, { onProgress: progressReporter() });
  await rename(part, dest);
}
