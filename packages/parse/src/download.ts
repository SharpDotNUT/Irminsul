import { execFileSync } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

export const ARTIFACT_REPO = "Escartem/AnimeStudio";
export const ARTIFACT_NAME = "AnimeStudio-net10";
export const NIGHTLY_URL = `https://nightly.link/${ARTIFACT_REPO}/workflows/build/master/${ARTIFACT_NAME}.zip`;

const API_ROOT = "https://api.github.com";
const USER_AGENT = "irminsul-parse";

type WorkflowRun = { id: number; head_sha: string };
type Artifact = { name: string; expired: boolean; archive_download_url: string };

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
export function githubToken(): string | undefined {
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

/** Latest successful `master` run's artifact, ready to download (token required by GitHub). */
export async function resolveLatestArtifact(): Promise<{ url: string; token: string | undefined; runId: number }> {
  const token = githubToken();
  const runs = (await githubApi(
    `/repos/${ARTIFACT_REPO}/actions/runs?branch=master&status=success&per_page=1`,
    token,
  )) as { workflow_runs?: WorkflowRun[] };
  const run = runs.workflow_runs?.[0];
  if (!run) throw new Error(`${ARTIFACT_REPO} 的 master 分支没有成功的 workflow run`);

  const artifacts = (await githubApi(
    `/repos/${ARTIFACT_REPO}/actions/runs/${run.id}/artifacts`,
    token,
  )) as { artifacts?: Artifact[] };
  const available = artifacts.artifacts ?? [];
  const artifact = available.find((entry) => entry.name === ARTIFACT_NAME && !entry.expired);
  if (!artifact) {
    const names = available.map((entry) => entry.name).join(", ") || "(无)";
    throw new Error(`run ${run.id} 没有可用的 ${ARTIFACT_NAME} 构建产物，现有: ${names}`);
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
    const total = Number(response.headers.get("content-length")) || null;
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
