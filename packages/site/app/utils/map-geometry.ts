/**
 * 站点侧的地图几何。
 *
 * 与 `packages/akasha/src/map-tiles.ts` 同源：同一份 `(-y, -x)` 格子映射、同一份 `levelTiles()`
 * 档位规则。生成器按它决定"写哪些瓦片"，查看器按它决定"请求哪些瓦片"，两边错开就会打出 404
 * 或留下空白 —— 改动必须两处一起改。
 *
 * 三条规则（都来自资源本身，不是约定）：
 *  1. 贴图 `UI_MapBack[_Region]_x_y` 铺在格 `(-y, -x)` 上，一格是 `cell` 世界像素；
 *  2. 贴图的像素尺寸是**该格的细节上限**，不是覆盖范围 —— 图片永远铺满整格；
 *  3. 一格只在 `R ≤ 自己的原生尺寸` 的档位上有瓦片，所以任意档位的任意位置沿粗档一定能找到祖先。
 */

/** 一块瓦片的边长（图像像素）。 */
export const TILE = 512;
/** 全部档位：每格多少像素，从粗到细。 */
export const LEVELS = [16, 32, 64, 128, 256, 512, 1024, 2048];

/** `formatted/map.json` 的形态（`akasha pyramid` 写出）。 */
export type MapManifest = {
  /** 一格的世界像素边长。 */
  cell: number;
  /** region → 贴图原生像素尺寸 → [x, y] 列表。 */
  regions: Record<string, Record<string, [number, number][]>>;
};

export type MapCell = {
  x: number;
  y: number;
  cx: number;
  cy: number;
  size: number;
  asset: string;
};

export type MapGrid = {
  region: string;
  cell: number;
  cells: MapCell[];
  byCell: Map<string, MapCell>;
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
  /** `R → 该档存在的瓦片`（惰性算出）。 */
  levels: Map<number, Set<string>>;
};

/** 把清单变成按 region 的网格，并把每个 region 的原生尺寸展开成格子。 */
export function gridsOf(manifest: MapManifest): Map<string, MapGrid> {
  const grids = new Map<string, MapGrid>();
  for (const [region, sizes] of Object.entries(manifest.regions)) {
    const prefix = region === "Teyvat" ? "" : `${region}_`;
    const cells: MapCell[] = [];
    const byCell = new Map<string, MapCell>();
    for (const [size, coords] of Object.entries(sizes)) {
      for (const [x, y] of coords) {
        // 格 (-y, -x)；`|| 0` 把 -0 归成 0，否则 `-0` 与 `0` 在 Map 里是两个键。
        const cx = -y || 0;
        const cy = -x || 0;
        const cell: MapCell = { x, y, cx, cy, size: Number(size), asset: `UI_MapBack_${prefix}${x}_${y}` };
        cells.push(cell);
        byCell.set(`${cx},${cy}`, cell);
      }
    }
    const xs = cells.map((item) => item.cx);
    const ys = cells.map((item) => item.cy);
    grids.set(region, {
      region,
      cell: manifest.cell,
      cells,
      byCell,
      cx0: Math.min(...xs),
      cy0: Math.min(...ys),
      cx1: Math.max(...xs),
      cy1: Math.max(...ys),
      levels: new Map(),
    });
  }
  return grids;
}

/**
 * 画哪一档：覆盖一格在屏幕上的尺寸所需的最粗档。过采样最多 2× 好过放大最多 2×，
 * 而档距恰好 ×2 正是"父档可以当作精确 2×2 替身"的前提。
 */
export function levelFor(cellPx: number): number {
  let R = LEVELS[0]!;
  const top = LEVELS[LEVELS.length - 1]!;
  while (R < top && R < cellPx) R *= 2;
  return R;
}

/** 某一档存在的瓦片（键 `"gx,gy"`）。只在请求它有的瓦片，所以永远不会打出 404。 */
export function levelTiles(grid: MapGrid, R: number): Set<string> {
  let set = grid.levels.get(R);
  if (set) return set;
  set = new Set<string>();
  for (const cell of grid.cells) {
    if (cell.size < R) continue;
    const rx = (cell.cx - grid.cx0) * R;
    const ry = (cell.cy - grid.cy0) * R;
    for (let gx = Math.floor(rx / TILE); gx <= Math.floor((rx + R - 1) / TILE); gx++) {
      for (let gy = Math.floor(ry / TILE); gy <= Math.floor((ry + R - 1) / TILE); gy++) {
        set.add(`${gx},${gy}`);
      }
    }
  }
  grid.levels.set(R, set);
  return set;
}

/** 一块瓦片的世界矩形：`[x, y, size]`。 */
export function tileRect(grid: MapGrid, R: number, gx: number, gy: number): [number, number, number] {
  const size = TILE * (grid.cell / R);
  return [grid.cx0 * grid.cell + gx * size, grid.cy0 * grid.cell + gy * size, size];
}

/** 覆盖某个世界矩形的瓦片位置，并按 region 网格夹住（边界算命中，只多不漏）。 */
export function visibleTiles(
  grid: MapGrid,
  R: number,
  wx0: number,
  wy0: number,
  wx1: number,
  wy1: number,
): { gx: number; gy: number; x: number; y: number; size: number }[] {
  const size = TILE * (grid.cell / R);
  const lastX = Math.ceil(((grid.cx1 - grid.cx0 + 1) * R) / TILE) - 1;
  const lastY = Math.ceil(((grid.cy1 - grid.cy0 + 1) * R) / TILE) - 1;
  const gx0 = Math.max(0, Math.floor((wx0 - grid.cx0 * grid.cell) / size));
  const gy0 = Math.max(0, Math.floor((wy0 - grid.cy0 * grid.cell) / size));
  const gx1 = Math.min(lastX, Math.floor((wx1 - grid.cx0 * grid.cell) / size));
  const gy1 = Math.min(lastY, Math.floor((wy1 - grid.cy0 * grid.cell) / size));
  const out = [];
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      out.push({ gx, gy, size, x: grid.cx0 * grid.cell + gx * size, y: grid.cy0 * grid.cell + gy * size });
    }
  }
  return out;
}

/** 某个世界点落在哪块瓦片上。档位逐倍减半，所以往粗档走一位就是坐标右移一位。 */
export function tileAtWorld(grid: MapGrid, R: number, wx: number, wy: number): [number, number] {
  const size = TILE * (grid.cell / R);
  return [
    Math.floor((wx - grid.cx0 * grid.cell) / size),
    Math.floor((wy - grid.cy0 * grid.cell) / size),
  ];
}

/** 整个 region 的世界包围盒 `[x0, y0, x1, y1]`。 */
export function boundsOf(grid: MapGrid): [number, number, number, number] {
  return [
    grid.cx0 * grid.cell,
    grid.cy0 * grid.cell,
    (grid.cx1 + 1) * grid.cell,
    (grid.cy1 + 1) * grid.cell,
  ];
}

export function tileUrl(tilesBase: string, grid: MapGrid, R: number, gx: number, gy: number): string {
  return `${tilesBase}${grid.region}/${R}/${gx}_${gy}.webp`;
}
