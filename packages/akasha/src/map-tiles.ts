/**
 * 把 `akasha export` 出来的 UI_MapBack 贴图切成标准 WebP 瓦片金字塔（站点地图浏览的数据源）。
 *
 * 布局：`{out}/{region}/{R}/{gx}_{gy}.webp`，外加一份清单 `{out}/map.json`。
 *
 * 三条规则决定了整个形状，都来自资源本身：
 *  1. 贴图 `UI_MapBack[_Region]_x_y` 铺在网格格 `(-y, -x)` 上，一格是 2048 世界像素；
 *  2. 贴图自身的像素尺寸（2048/1024/128/64）是**该格的细节上限**，不是覆盖范围 —— 图片永远铺满整格；
 *  3. `R` 是该档每格多少像素，从 2048 逐倍减半到 16；一格只在 `R ≤ 自己的原生尺寸` 的档上出瓦片，
 *     所以细档天然稀疏，而**任意档位的任意位置沿粗档一定能找到祖先**（客户端据此跨档回退，不闪空白）。
 *
 * 客户端（`packages/site/app/utils/map-geometry.ts`）用同一份 `levelTiles()` 规则算出该请求哪些瓦片，
 * 所以永远不会打出 404。两边规则必须一起改。
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blank, blit, crop, decodePng, encodeBmp, halve, isBlank, type RawImage } from "./image.ts";
import { log, warn } from "./log.ts";

/** `Bun.Image` 这条管线里用到的部分（见 `image.ts` 顶部说明）。 */
type PngStage = { bytes: () => Promise<Uint8Array> };
type ImagePipeline = {
  metadata: () => Promise<{ width: number; height: number }>;
  resize: (width: number, height: number, options: { filter: string }) => ImagePipeline;
  png: (options?: { compressionLevel: number }) => PngStage;
  webp: (options: { quality: number }) => { write: (path: string) => Promise<unknown> };
};
declare const Bun: { Image: new (input: Uint8Array | string) => ImagePipeline };

/** 一格的世界像素边长。与"该格的图片有多大"无关，是资源自身的约定。 */
export const CELL = 2048;
/** 一块瓦片的边长（图像像素）。 */
export const TILE = 512;
/** 全部档位，每格多少像素，从粗到细：最低档由查看器的最小缩放决定，最高档就是原生上限。 */
export const LEVELS = [16, 32, 64, 128, 256, 512, 1024, 2048] as const;
/** 瓦片目录里那份清单的文件名；上传时它归 `formatted/`，瓦片本身归 `binary/MapTile/`。 */
export const MAP_MANIFEST = "map.json";

/** WebP 质量；与查看器无关，只影响体积/画质。 */
const QUALITY = 85;

/** 主图 `UI_MapBack_{x}_{y}` 没有区域段（属于 Teyvat），子图 `UI_MapBack_{Region}_{x}_{y}` 有。 */
const MAP_BACK = /^UI_MapBack_(?:([A-Za-z]+)_)?(-?\d+)_(-?\d+)$/;

/** 贴图清单：`region → 原生像素尺寸 → [x, y] 列表`，外加一格多少世界像素。 */
export type TileListing = {
  cell: number;
  regions: Record<string, Record<string, [number, number][]>>;
};

/** 一个格子在网格里的位置（`(x, y)` 是资源坐标，`(cx, cy)` 是格坐标）。 */
export type MapCell = {
  x: number;
  y: number;
  cx: number;
  cy: number;
  /** 该格贴图的原生像素尺寸，即它自己的细节上限。 */
  size: number;
  /** 资源名（`UI_MapBack_...`），只在日志与站点 HUD 里用。 */
  asset: string;
};

export type MapGrid = {
  region: string;
  cells: MapCell[];
  byCell: Map<string, MapCell>;
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
};

/** 源 PNG 的宽（IHDR 里字节 16..20，大端）；只读头，不解码整张图。所有贴图都是正方形。 */
function pngWidth(path: string): number {
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(24);
    readSync(fd, head, 0, head.length, 0);
    return head.readUInt32BE(16);
  } finally {
    closeSync(fd);
  }
}

/** 清点导出目录里的 UI_MapBack 贴图。主图没有区域段，归 Teyvat。 */
export function scanMapBackTiles(exportDir: string): TileListing {
  const dir = join(exportDir, "Texture2D");
  if (!existsSync(dir)) {
    throw new Error(`找不到贴图目录: ${dir}\n请先运行: akasha export --group map-back`);
  }
  const regions: Record<string, Record<string, [number, number][]>> = {};
  let skipped = 0;
  for (const file of readdirSync(dir).sort()) {
    if (!file.startsWith("UI_MapBack_") || !file.endsWith(".png")) continue;
    const match = MAP_BACK.exec(file.slice(0, -4));
    if (match === null) {
      skipped += 1; // UI_MapBack_None：64×64 的空占位，没有坐标
      continue;
    }
    const region = match[1] ?? "Teyvat";
    const size = String(pngWidth(join(dir, file)));
    const bySize = (regions[region] ??= {});
    (bySize[size] ??= []).push([Number(match[2]), Number(match[3])]);
  }
  const names = Object.keys(regions);
  if (names.length === 0) {
    throw new Error(`${dir} 里没有 UI_MapBack 贴图\n请先运行: akasha export --group map-back`);
  }
  if (skipped > 0) log(`跳过 ${skipped} 个没有坐标的 UI_MapBack_None.png`);
  return { cell: CELL, regions };
}

/** region 的展示顺序：Teyvat 在前（它是主图），其余按名字排序。 */
function regionOrder(regions: string[]): string[] {
  return [...regions].sort((a, b) => (a === "Teyvat" ? -1 : b === "Teyvat" ? 1 : a.localeCompare(b)));
}

/** 资源坐标 → 格坐标。`|| 0` 把 `-0` 归一成 `0`（`-0` 会让 Map 的键与 `0` 不同）。 */
export function cellOf(x: number, y: number): [number, number] {
  return [-y || 0, -x || 0];
}

/** 把清单切成带格坐标与边界的网格。 */
export function gridOf(region: string, sizes: Record<string, [number, number][]>): MapGrid {
  const prefix = region === "Teyvat" ? "" : `${region}_`;
  const cells: MapCell[] = [];
  const byCell = new Map<string, MapCell>();
  for (const [size, coords] of Object.entries(sizes)) {
    for (const [x, y] of coords) {
      const [cx, cy] = cellOf(x, y);
      const cell: MapCell = { x, y, cx, cy, size: Number(size), asset: `UI_MapBack_${prefix}${x}_${y}` };
      cells.push(cell);
      byCell.set(`${cx},${cy}`, cell);
    }
  }
  const xs = cells.map((cell) => cell.cx);
  const ys = cells.map((cell) => cell.cy);
  return {
    region,
    cells,
    byCell,
    cx0: Math.min(...xs),
    cy0: Math.min(...ys),
    cx1: Math.max(...xs),
    cy1: Math.max(...ys),
  };
}

/**
 * 某一档本该存在的瓦片，键是 `"gx,gy"`。一格只在自己原生尺寸及更粗的档上出瓦片，
 * 所以 `R=2048` 只有 43 个 2048 原生格贡献出的 688 块（Teyvat）。
 */
export function levelTiles(grid: MapGrid, R: number): Set<string> {
  const out = new Set<string>();
  for (const cell of grid.cells) {
    if (cell.size < R) continue;
    const rx = (cell.cx - grid.cx0) * R;
    const ry = (cell.cy - grid.cy0) * R;
    for (let gx = Math.floor(rx / TILE); gx <= Math.floor((rx + R - 1) / TILE); gx++) {
      for (let gy = Math.floor(ry / TILE); gy <= Math.floor((ry + R - 1) / TILE); gy++) {
        out.add(`${gx},${gy}`);
      }
    }
  }
  return out;
}

/**
 * 读一张源 PNG 的原始像素，必要时交给 `Bun.Image` 重采样。
 * `filter` 为 null 时不做缩放（源图尺寸已经对了，避免 1:1 重采样把像素磨软）。
 */
async function rawOf(path: string, size: number, filter: "lanczos3" | "cubic" | null): Promise<RawImage> {
  const image = filter === null ? new Bun.Image(path) : new Bun.Image(path).resize(size, size, { filter });
  // 中间产物只要"能被我读回来"，压缩纯属浪费：level 0 让 zlib 存原始块。
  return decodePng(await image.png({ compressionLevel: 0 }).bytes());
}

type Writer = {
  outDir: string;
  region: string;
  tiles: number;
  bytes: number;
  /** 整块透明的瓦片数：切片偏移写错时总量看着正常，只有这条能发现。 */
  empty: number;
};

/** 从 `raw` 的 `(sx, sy)` 裁一块 TILE² 写成一档瓦片；超出 `raw` 的部分留透明。 */
async function writeTile(writer: Writer, R: number, raw: RawImage, sx: number, sy: number, gx: number, gy: number): Promise<void> {
  const tile = crop(raw, sx, sy, TILE, TILE);
  if (isBlank(tile)) writer.empty += 1;
  const dir = join(writer.outDir, writer.region, String(R));
  mkdirSync(dir, { recursive: true });
  const written = await new Bun.Image(encodeBmp(tile)).webp({ quality: QUALITY }).write(join(dir, `${gx}_${gy}.webp`));
  writer.tiles += 1;
  writer.bytes += typeof written === "number" ? written : statSync(join(dir, `${gx}_${gy}.webp`)).size;
}

async function buildRegion(writer: Writer, grid: MapGrid, textureDir: string): Promise<void> {
  // 细档（R ≥ TILE）：一块瓦片永远不跨格，所以每格自成一个正方形金字塔，逐倍减半即可。
  for (const cell of grid.cells) {
    if (cell.size < TILE) continue;
    let R: number = Math.min(cell.size, LEVELS[LEVELS.length - 1]!);
    let raw = await rawOf(join(textureDir, `${cell.asset}.png`), R, R === cell.size ? null : "lanczos3");
    while (R >= TILE) {
      const gx0 = ((cell.cx - grid.cx0) * R) / TILE;
      const gy0 = ((cell.cy - grid.cy0) * R) / TILE;
      for (let j = 0; j < R / TILE; j++) {
        for (let i = 0; i < R / TILE; i++) {
          await writeTile(writer, R, raw, i * TILE, j * TILE, gx0 + i, gy0 + j);
        }
      }
      R /= 2;
      if (R >= TILE) raw = halve(raw);
    }
  }

  // 粗档（R < TILE）：一块瓦片跨多个格，先按 256 px/格把每个格各自重采样后拼成整张 region 图
  // （每格分别采样、再拼，绝不跨格取样），再逐倍对半缩。Teyvat 这一步峰值约 110 MB。
  const base = TILE / 2;
  let regionImage = blank((grid.cx1 - grid.cx0 + 1) * base, (grid.cy1 - grid.cy0 + 1) * base);
  for (const cell of grid.cells) {
    const raw = await rawOf(join(textureDir, `${cell.asset}.png`), base, cell.size > base ? "lanczos3" : "cubic");
    blit(regionImage, raw, (cell.cx - grid.cx0) * base, (cell.cy - grid.cy0) * base);
  }
  for (let R = base; R >= LEVELS[0]!; R /= 2) {
    for (const key of levelTiles(grid, R)) {
      const comma = key.indexOf(",");
      const gx = Number(key.slice(0, comma));
      const gy = Number(key.slice(comma + 1));
      await writeTile(writer, R, regionImage, gx * TILE, gy * TILE, gx, gy);
    }
    if (R > LEVELS[0]!) regionImage = halve(regionImage);
  }
}

export type PyramidOptions = {
  /** `akasha export` 的产物目录，用其中的 `Texture2D/UI_MapBack_*.png`。 */
  exportDir: string;
  /** 瓦片目录（会写出各 region 子目录与 `map.json`）。 */
  outDir: string;
  /** 只切这些 region，默认全部。清单只列本次切出来的 region。 */
  regions: string[];
};

export type PyramidResult = { regions: string[]; tiles: number; bytes: number };

/** 切出全部（或指定的）region 的瓦片金字塔，并写下清单。 */
export async function buildPyramid(options: PyramidOptions): Promise<PyramidResult> {
  const listing = scanMapBackTiles(options.exportDir);
  const available = regionOrder(Object.keys(listing.regions));
  const selected = new Set(options.regions);
  const wanted = selected.size > 0 ? available.filter((name) => selected.has(name)) : available;
  for (const region of selected) {
    if (!(region in listing.regions)) {
      throw new Error(`没有该区域的贴图: ${region}（可用: ${available.join(", ")}）`);
    }
  }

  mkdirSync(options.outDir, { recursive: true });
  const built: Record<string, Record<string, [number, number][]>> = {};
  let tiles = 0;
  let bytes = 0;
  let empty = 0;
  for (const region of wanted) {
    const grid = gridOf(region, listing.regions[region]!);
    const writer: Writer = { outDir: options.outDir, region, tiles: 0, bytes: 0, empty: 0 };
    const started = Date.now();
    await buildRegion(writer, grid, join(options.exportDir, "Texture2D"));
    built[region] = listing.regions[region]!;
    tiles += writer.tiles;
    bytes += writer.bytes;
    empty += writer.empty;
    log(
      `${region.padEnd(13)} ${String(writer.tiles).padStart(5)} 块瓦片  ` +
        `${(writer.bytes / 1024 / 1024).toFixed(1).padStart(6)} MiB  ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
  }
  if (empty > 0) {
    warn(`有 ${empty} 块瓦片整块透明（本该覆盖到某个格），切片偏移可能写歪了`);
  }

  const manifest: TileListing = { cell: CELL, regions: built };
  await writeFile(join(options.outDir, MAP_MANIFEST), `${JSON.stringify(manifest)}\n`);
  return { regions: wanted, tiles, bytes };
}
