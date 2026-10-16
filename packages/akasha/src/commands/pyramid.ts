import { join, resolve } from "node:path";
import { WORK_PATHS, type Context } from "../context.ts";
import { log } from "../log.ts";
import { MAP_MANIFEST, buildPyramid } from "../map-tiles.ts";
import { trace } from "../timing.ts";

export type PyramidOptions = {
  /** `akasha export` 的产物目录（用其中的 `Texture2D/UI_MapBack_*.png`），默认 `<workDir>/export`。 */
  input?: string;
  /** 瓦片目录（含清单 `map.json`），默认 `<workDir>/pyramid`。 */
  out?: string;
  /** 只切这些 region，默认全部。 */
  regions: string[];
};

export async function pyramidCommand(ctx: Context, options: PyramidOptions): Promise<void> {
  const exportDir = resolve(options.input ?? join(ctx.workDir, WORK_PATHS.export));
  const outDir = resolve(options.out ?? join(ctx.workDir, WORK_PATHS.pyramid));
  log(`来源: ${exportDir}`);
  log(`输出: ${outDir}`);

  const result = await trace("切出瓦片金字塔", () =>
    buildPyramid({ exportDir, outDir, regions: options.regions }),
  );

  log(`共 ${result.regions.length} 个 region / ${result.tiles} 块瓦片 / ${(result.bytes / 1024 / 1024).toFixed(1)} MiB`);
  log(`清单: ${join(outDir, MAP_MANIFEST)}`);
  log(`提示: 用 akasha upload 把瓦片推到 Static/GI/binary/MapTile/，清单推到 Static/GI/formatted/map.json`);
}
