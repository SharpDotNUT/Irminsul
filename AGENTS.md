# Repository Guidelines

## Project Overview

Irminsul is a private Bun + pnpm workspace with two packages. `@irminsul/akasha` is a thin TypeScript CLI with two upstream
sources: the external **AnimeStudio CLI** (`AnimeStudio.CLI.exe`, a `net10.0-windows` .NET build) that extracts
assets from Genshin Impact's AssetBundle shards, and the **DimbreathBot/AnimeGameData** JSON dumps used for
localized emoji metadata:

1. `akasha init` — download + extract the AnimeStudio CLI build into the work dir.
2. `akasha build_map` — scan the game's `blocks/` folder and build `assets_map.map` (MessagePack index).
3. `akasha export` — resolve the map and export selected `Texture2D` assets to PNG (by default into `<workDir>/export/`).
4. `akasha emoji` — merge both `Emoji*ExcelConfigData` sheets into one config (texts stay hash references) and
   write one hash→text file per language from every `TextMap_Medium*` shard (RU/TH shards merged).
5. `akasha pyramid` — cut the exported `UI_MapBack` tiles into a WebP tile pyramid (`<workDir>/pyramid/`) plus a
   `map.json` manifest, so the site can pan/zoom the map without 404s, blanks or per-cell 2048² decodes.
6. `akasha upload` — push those products plus the PNGs exported into `<workDir>/export/` to Cloudflare R2 under
   `Static/GI/`, split into `formatted/` (JSON/text) and `binary/` (images) — the map tiles land under
   `binary/MapTile/` and their manifest in `formatted/map.json` — skipping objects already there with the same size.

The wrapper adds flag ergonomics, environment-based path resolution, rule-driven asset selection, JSON shape
normalization, download fallback and an R2 upload step. Actual asset parsing is entirely the upstream binary's
job — do not reimplement decoding here.

`@irminsul/site` (`packages/site`, Nuxt 4 + Varlet) is the browsing UI for those products: a client-only static SPA
(`ssr: false`) with **two routes**, linked by a top nav — `/` **表情包** (fetches
`Static/GI/formatted/emoji.json`, one `texts/<LANG>.json` per selected language and the PNGs straight from the
bucket's public domain, showing one pack per tab) and `/map` **地图** (fetches `formatted/map.json` then draws the
`binary/MapTile/<region>/<R>/<gx>_<gy>.webp` pyramid onto a canvas with pan/zoom). All of it comes from the bucket's
public domain (`NUXT_PUBLIC_ASSETS_BASE`); it never reads `.parse/` and needs no game install or `R2_*` credentials.
The two are **routes, not tabs of one page**: each page is its own lazy chunk and navigating unmounts the other, so
the map's canvas + tile cache (a few hundred MB of live bitmaps) can never pile onto the emoji page's 800-odd
`<img>`s in the same document — opening `/map` directly never allocates the emoji view at all.

## Architecture & Data Flow

Layers (strictly one direction: `cli.ts` → `commands/` → shared modules):

| Layer | Module | Role |
| --- | --- | --- |
| Entry | `packages/akasha/src/cli.ts` | hand-rolled flag parser, `COMMANDS` registry, `printUsage`, single try/catch → `process.exitCode = 1` |
| Commands | `src/commands/{init,build_map,export,emoji,pyramid,upload}.ts` | `xxxCommand(ctx, options)` → `Promise<void>`; argv assembly for the upstream binary |
| Paths | `src/context.ts` | `Context {workDir, game, silent}`, the `WORK_PATHS` work-dir layout, `resolveWorkDir` (`--work-dir` > `PARSE_WORK_DIR` > `<project root>/.parse`) |
| Inputs | `src/genshin.ts` | `resolveScanRoot` (`--input` > `GENSHIN_DIR`) → the `blocks` folder or a single `.blk` |
| Exec | `src/anime-studio.ts` | CLI acquisition (`downloadCliArchive`: nightly.link → GitHub artifact fallback), `CLI_EXE`, `findCli`, `cliVersion`, `runCli` (win32 guard) |
| Download / zip | `src/download.ts`, `src/zip.ts` | generic `downloadTo` + `progressReporter` + `downloadCached` + `resolveArtifact`, zip magic check + dependency-free zip extractor |
| Export only | `src/rules.ts` + `src/rules.json` | named regex groups → `patternsForGroups` |
| Emoji only | `src/emoji.ts` | DimbreathBot URLs + `mergeConfigData`/`mergeTextMaps`/`buildTexts` (config merge, container/field-name drift, RU/TH shard merge, per-language split) |
| Map tiles | `src/map-tiles.ts` + `src/image.ts` | `UI_MapBack_*` scan (region/coords from the filename, native size from the PNG header), the `(-y,-x)` cell mapping, `levelTiles`, the pyramid builder and the `map.json` manifest; `image.ts` is the raw-RGBA bridge over `Bun.Image` (PNG in, BMP out, `crop`/`halve`/`blit`/`isBlank`) |
| Upload | `src/s3.ts` | `Bun.S3Client` facade: `R2_*` env config, paged prefix listing, single-file upload (`Content-Type` from the extension) |
| Logging | `src/log.ts` | `log` (suppressed by `--silent`), `warn` (never suppressed), `setLogSink` (every line also goes to the run log) |
| Timing | `src/timing.ts` | `startTrace`/`finishTrace` (called from `cli.ts`, one `<workDir>/logs/<command>-<stamp>.log` per run) and `trace(label, fn)` — commands time each phase, the run ends with a summary |

Data flow per command:

- **init**: `downloadCliArchive` fetches the archive → nightly.link URL, on failure the latest successful `master`
  GitHub Actions run's `AnimeStudio-net10` artifact (needs `GITHUB_TOKEN`/`GH_TOKEN`/`gh auth`) → PK magic check
  (`assertZipFile`) → `extractZip` (strips the artifact's single root folder) → `<workDir>/anime-studio/`.
- **build_map**: `resolveScanRoot` → spawn `<blocks> maps --game GI --map_op AssetMap --map_type MessagePack --types <T>…`
  with `cwd = workDir` → `<workDir>/maps/assets_map.map`.
- **export**: rule groups → regex list written to `<workDir>/names.txt` → spawn
  `<blocks> <out> --map_op AssetMap,Load --map_name <map> --types Texture2D --names names.txt --group_assets ByType --export_type Convert`
  → `<out>/Texture2D/*.png`, `<out>` = `--out` or `<workDir>/export/` (the reusable cache `akasha upload` reads).
- **emoji**: both `ExcelBinOutput` sheets + every `TextMap_Medium<suffix>` shard (raw.githubusercontent `main`;
  RU = `RU_0`+`RU_1`, TH = `TH_0`+`TH_1`) → `<workDir>/dimbreath/` (raw cache; `--force` refetches) →
  `mergeConfigData` folds the emoji rows into their sets (`order`-sorted) and keeps `nameTextMapHash` /
  `contentTextMapHash` as **hash references** → `<out>/emoji.json`; each shard is parsed, filtered down to the
  878 referenced hashes and dropped (`mergeTextMaps`, so ~350MB of input never sits in memory at once) →
  `buildTexts` → `<out>/texts/<LANG>.json` = `{"<hash>": "文案"}` (`<out>` = `--out` or `<workDir>/emoji/`).
- **pyramid**: `scanMapBackTiles` reads `<export>/Texture2D/UI_MapBack_*.png` — region and `(x, y)` from the
  filename (`UI_MapBack_None.png` is skipped), native pixel size from the PNG header — → `gridOf` builds the
  `(-y, -x)` cells → per cell with `size >= TILE`, `Bun.Image` gives the raw RGBA at `min(size, 2048)`, each finer
  level is a 2× box halving, and every 512² tile is cropped out, wrapped as BMP, and re-encoded by `Bun.Image` to
  WebP; levels below 512 are one per-cell-resampled region image halved repeatedly. Output
  `<out>/<region>/<R>/<gx>_<gy>.webp` plus `<out>/map.json` (`<out>` = `--out` or `<workDir>/pyramid/`).
- **upload**: `<emojiDir>` (`--emoji` or `<workDir>/emoji`) → `Static/GI/formatted/**`, `<imagesDir>` (`--images`,
  default `<workDir>/export` — the tree `akasha export` writes) walking every file recursively →
  `Static/GI/binary/**`, `<tilesDir>` (`--pyramid` or `<workDir>/pyramid`) → `Static/GI/binary/MapTile/**` with
  `map.json` pulled out to `Static/GI/formatted/map.json`; the whole `Static/GI/` prefix is listed once up front and
  objects whose size already matches are skipped.

Two upstream facts drive most of the code: reading an existing map requires the composed flag
**`--map_op AssetMap,Load`** (`AssetMap` alone rebuilds), and map `Source` entries are absolute paths, so a map
built against a moved game folder is dead.

## Key Directories

- `packages/akasha/src/` — all source; one file per subcommand under `src/commands/`, shared modules at `src/` root.
- `packages/akasha/src/rules.json` — export selection rules as **data** (regex groups + `default` list). Extend the
  default export set here, not in TypeScript.
- `packages/site/app/app.vue` — the shell only: the app bar, the nav (`/` 表情包 / `/map` 地图) and `<NuxtPage />`.
- `packages/site/app/pages/index.vue` — the emoji page (`/`): two `useAsyncData`s (the config once, the texts keyed
  by language so a language switch refetches only the texts), one computed that joins them into packs, search/filter,
  the pack list, the emoji grid (`var-image` with `lazy`), loading/empty/error states
  (`var-loading`/`var-result`), and an incremental reveal — 「全部表情」 holds 827 tiles, so only `CHUNK` of them are
  mounted at a time and the 「显示更多」 row doubles as the `IntersectionObserver` sentinel that continues it.
- `packages/site/app/pages/map.vue` — the map page (`/map`): canvas renderer, level selection, parent-tile
  fallback, tile cache/eviction/prefetch, pan/zoom/double-click, the perf + cursor panel.
- `packages/site/app/utils/map-geometry.ts` — the client half of the tile contract (`gridsOf`, `levelFor`,
  `levelTiles`, `tileRect`, `visibleTiles`, `tileAtWorld`, `boundsOf`, `tileUrl`). **It mirrors
  `packages/akasha/src/map-tiles.ts`; change both together** — the generator writes exactly the tiles the viewer
  asks for, and a client that asks for a tile the generator never wrote logs 404s instead of drawing.
- `packages/site/nuxt.config.ts` — assets base, the Varlet on-demand resolver wiring, and the MD3 dark design vars
  inlined into `<head>`.
- `packages/site/app/components.d.ts` — **generated** by the resolver on `nuxt dev`/`build`; committed so a clean
  checkout typechecks. Do not hand-edit.
- `packages/site/app/assets/main.css` — page skeleton only (layout + a few classes); every colour comes from
  Varlet's design variables.
- `README.md`（根）与 `packages/akasha/README.md` — 面向使用者的说明（快速开始、逐命令参数、产物路径与远端布局）；
  本文件则是给 agent/协作者的约定，两者分工、不互相重复。
- `.parse/` — gitignored runtime work dir: `anime-studio/` (extracted CLI), `maps/assets_map.map`, `names.txt`,
  `downloads/`, `export/` (`akasha export` 的 PNG 产物，upload 的来源), `dimbreath/` (raw upstream emoji JSON,
  ~348MiB), `emoji/` (products: `emoji.json` + `texts/<LANG>.json`), `pyramid/` (`akasha pyramid` 的瓦片金字塔 +
  清单 `map.json`) and `logs/` (每次运行的耗时日志，一次运行一个文件，
  只有几 KB，可以随时删). The name (and `PARSE_WORK_DIR`) is
  deliberately kept after the `parse` → `@irminsul/akasha` rename: it holds the expensive caches, so renaming the
  directory would mean moving them. Never edit by hand; refresh the CLI with
  `akasha init --force`, rebuild the map only when the game folder actually changed, refetch the Dimbreath JSON with
  `akasha emoji --force` (its cache is only as fresh as the last run), rebuild `pyramid/` with
  `akasha pyramid --out .parse/tmp-pyramid` when experimenting, and **leave `maps/`, `export/` and `pyramid/` alone**
  (see the warning below).

> **`.parse/maps/assets_map.map`, `.parse/export/` and `.parse/pyramid/` are expensive caches — do not delete or
> re-create them casually.** A full `build_map` reads every `.blk` in the game folder (1925 files / ~54 GB ⇒ ~8 min
> on this machine, and hours on larger installs). During development: keep `.parse/maps/assets_map.map` in place,
> run `akasha export` against it (seconds, no rescan) to exercise changes, and when a fresh index really is needed
> build a subset with `akasha build_map --input '<blocks>/00'` (or a single `.blk`) instead of rescanning everything.
> Never treat deleting `.parse/` or re-running `build_map` as a routine "clean" step; note that widening `--types`,
> changing the game folder, or moving the install invalidates the cached `Source` paths and forces a full rebuild.
> `.parse/pyramid/` is downstream of `export/` (58 s here, and only reproducible while `export/` exists), so build it
> into a throwaway `--out <dir>` when experimenting rather than overwriting the shared tree.
>
> `.parse/export/` is the same kind of cache: it can only be rebuilt while the map — whose `Source` paths point
> back into the game install — and the game folder itself are still in place, and it is exactly what `akasha upload`
> reads. Re-exporting is incremental: deleting a PNG and re-running the same rules regenerates it byte-identically
> (verified on `UI_EmotionTagIcon_46.png`, md5 `83116143470252985a54a6098af1a0b2`, 2792 → 2793 files), so keep the
> directory and re-export only when the rule set or the extracted assets actually changed. To try an experiment use
> `--out .parse/tmp-check` instead of the shared tree.

- `.agent/skills/anime-studio-assetmap-export/SKILL.md` — upstream CLI semantics, tested pitfalls and a known-good
  md5 baseline. Its absolute paths predate the `.parse/` layout; treat the flags as authoritative, the paths as stale.
- `.agent/skills/irminsul-map-tiles/SKILL.md` — the map tile contract (cell mapping, levels, the `Bun.Image` bridge,
  the viewer's two-pass paint, the pitfall list) and how to verify it without a browser.

## Development Commands

```bash
pnpm install                                 # workspace install (pnpm@11.5.0 pin)
pnpm typecheck                               # pnpm -r typecheck → tsc --noEmit — the only automated gate
pnpm akasha --help                           # command list, env vars, rule groups
pnpm akasha <cmd> --help                     # per-command flags
pnpm akasha init                             # download/extract AnimeStudio CLI (idempotent; --force to refresh)
pnpm akasha build_map                        # full game scan (~8 min, 1925 blk / 54 GB) — reuse this map, do not rebuild casually
pnpm akasha build_map --input '<blocks>/00'  # subset scan (fast iteration)
pnpm akasha export                           # 默认规则（8 组）→ .parse/export/Texture2D/*.png（复用 map，不重扫；这份产物是 upload 的来源）
pnpm akasha export --out .parse/tmp-check    # 试验性导出到独立目录，别动共享的 export/
pnpm akasha export --group logo --pattern '^UI_ItemIcon_1\d+$' --export-type Raw
pnpm akasha emoji                            # → .parse/emoji/{emoji.json,texts/<LANG>.json}（15 语言；首次约 350MB）
pnpm akasha pyramid                          # export 出的 UI_MapBack 贴图 → .parse/pyramid/{map.json,<region>/<R>/*.webp}（约 58s / 1670 块）
pnpm akasha pyramid --out .parse/tmp-pyramid # 试验性重切到独立目录，别动共享的 pyramid/
pnpm akasha upload                           # emoji 产物 + 贴图目录 + 地图瓦片 → R2 Static/GI/{formatted,binary}/（按前缀跳过已存在）
pnpm site                                    # 站点开发服务器 → http://127.0.0.1:3000（直接读 bucket，不碰 .parse）
pnpm site:build                              # 站点静态产物 → packages/site/.output/public
```

Equivalent direct form: `bun run packages/akasha/src/cli.ts <cmd> [flags]` (or `bun run src/cli.ts` inside
`packages/akasha`). The CLI has **no build, test, lint or format script** — do not introduce a bundler or transpile
step there. `packages/site` is the one package that builds (`nuxt generate`), and `pnpm typecheck`
(`pnpm -r typecheck`) covers both packages.

## Code Conventions & Common Patterns

- **ESM + explicit extensions**: `import { x } from "./mod.ts"`, `import type { … }`; always use `node:` prefixes.
- **Language split**: identifiers, comments and file names are English; every user-facing string (help, logs,
  errors, `rules.json` descriptions) is Chinese.
- **Errors**: `throw new Error("<what went wrong>，<actionable next step>")` (e.g. `请先运行: akasha init`). Only
  `main()` catches, printing `error: <message>` and setting exit code 1. Never swallow; never `process.exit()`.
- **Flags**: register in `COMMANDS[cmd].flags` as `value`/`bool`; long-form only; bool flags must not take a value;
  repeated value flags accumulate; comma-separated lists are split by `flagValues`; string enums are
  `Record<string, true>` allowlists validated by `pickEnum` (no TS `enum`).
- **Async**: `async`/`await` only; child-process completion via `Promise.withResolvers<T>()` with `error` + `close`
  handlers (`anime-studio.ts`).
- **No micro-helpers**: one-expression wrappers are inlined; extract a named function only when three or more call
  sites need identical behavior. No generic `utils.ts`.
- **Types as documentation**: `type` aliases over interfaces, `as const` path/flag maps (`WORK_PATHS`), explicit
  `unknown` + runtime shape checks at trust boundaries (`cli.ts` reading its own `package.json`).
- **Logging**: `log`/`warn` from `src/log.ts`; pass `--silent` through to the upstream binary when `ctx.silent`.
- **Preflight over crash**: existence checks with actionable messages (`findCli`, missing map, missing blocks dir).
- Keep the wrapper thin: new upstream behaviour = new flag passthrough, not re-implementation.

## Important Files

| Path | Why it matters |
| --- | --- |
| `packages/akasha/src/cli.ts` | single source of the CLI surface (commands, flags, enums, help text, error handling) |
| `packages/akasha/src/context.ts` | work-dir contract (`WORK_PATHS` layout, `projectRoot()` walks up for `pnpm-workspace.yaml`) |
| `packages/akasha/src/genshin.ts` | `GENSHIN_DIR` → `blocks` resolution rules (`*_Data` preference order) |
| `packages/akasha/src/anime-studio.ts` | CLI acquisition (`downloadCliArchive`: nightly.link → GitHub artifact fallback), upstream argv construction, `cwd = workDir`, win32 guard, exit-code hints |
|`packages/akasha/src/rules.json`|default export selection (8 groups: `logo`, `emotion-icon`, `emotion-tag-icon`, `avatar-icon`, `gacha-avatar-img`, `map-back`, `namecard-pic`, `chapter-icon`)|
| `packages/akasha/src/emoji.ts` | DimbreathBot file/language tables (`TEXT_MAP_LANGS` 分片) + `mergeConfigData`/`mergeTextMaps`/`buildTexts` (tolerates upstream shape drift) |
| `packages/akasha/src/map-tiles.ts` | 地图瓦片的唯一真源：`CELL`/`TILE`/`LEVELS`、`scanMapBackTiles`、`cellOf`、`gridOf`、`levelTiles`、`buildPyramid`（含 `map.json` 清单）。站点侧的 `map-geometry.ts` 是它面向浏览器的镜像 |
| `packages/akasha/src/image.ts` | `Bun.Image` 没有的那半：`decodePng`（读回自家 PNG）+ `encodeBmp`（把原始 RGBA 交回去）+ `crop`/`halve`/`blit`/`isBlank`；只处理我们自己产生的字节 |
| `packages/akasha/src/zip.ts` | zip64-capable extractor + `assertZipFile` magic check; traversal guard; no external `tar`/`Expand-Archive` |
| `packages/akasha/src/s3.ts` | `akasha upload` 的通道：`createS3()` 读 `R2_*` 环境变量 → 分页 `listKeys` + `upload`；只声明用到的 `Bun.S3Client` 表面（tsconfig 无 bun-types） |
| `packages/akasha/tsconfig.json` | akasha's tsconfig; every strictness flag for the CLI lives here |
| `packages/site/nuxt.config.ts` | assets base (`NUXT_PUBLIC_ASSETS_BASE`), Varlet on-demand resolver, MD3 dark design vars inlined into `<head>` |
| `packages/site/app/app.vue` | 站点外壳：app bar + 导航（`/` 表情包、`/map` 地图）+ `<NuxtPage />` |
| `packages/site/app/pages/index.vue` | 表情包页（`/`）全在这里：fetch、搜索、表情包标签、表情网格、加载/空/错误态 |
| `packages/site/app/pages/map.vue` | 地图页（`/map`）全在这里：canvas 渲染、档位选择、父档回退、瓦片缓存/驱逐/预取、平移缩放、读数面板 |
| `packages/site/app/utils/map-geometry.ts` | 站点侧的地图几何，必须与 `src/map-tiles.ts` 同步（档位规则、`(-y,-x)` 映射、URL 形状） |
| `packages/site/app/components.d.ts` | resolver-generated `GlobalComponents` types (committed; refreshed by any `nuxt dev`/`build`) |
| `package.json` (root) | workspace scripts `akasha`, `site`, `site:build`, `typecheck`; `engines.bun`, `packageManager` |
| `.env` | local `GENSHIN_DIR` + `R2_*` upload config; Bun auto-loads it for `bun run`/`bun` invocations |
| `.agent/skills/anime-studio-assetmap-export/SKILL.md` | upstream `--map_op`/filter semantics and pitfalls |
| `.agent/skills/irminsul-map-tiles/SKILL.md` | 地图瓦片的坐标系/档位规则、`Bun.Image` 桥接的边界、查看器两趟绘制与坑清单 |

## Runtime/Tooling Preferences

- **Bun ≥ 1.3.14 is the runtime** (`engines.bun`); sources execute unmodified from `src/` — `bin.akasha` points at
  `./src/cli.ts` and `noEmit` forbids a `dist/`. pnpm 11.5.0 is install-only.
- Object storage goes through Bun's built-in `Bun.S3Client` (`src/s3.ts`) — no AWS SDK dependency; the missing Bun
  types are declared locally there instead of relaxing `types: ["node"]`.
- Image work goes through Bun's built-in `Bun.Image` (`src/map-tiles.ts`): decode, SIMD resampling (`lanczos3`/
  `cubic`) and WebP encoding, again with no dependency. It cannot hand back raw pixels and has no crop/composite, so
  `src/image.ts` bridges that gap with a PNG decoder and a BMP encoder — see the header comment there before adding
  anything to the pipeline.
- The site's UI is **Varlet** (`@varlet/ui`), wired for on-demand import in `nuxt.config.ts` via
  `unplugin-vue-components` + `@varlet/import-resolver`: templates just write `<var-tabs>`/`<var-input>`/… and the
  resolver injects the component and its styles. Never import from the `@varlet/ui` barrel by hand — its top-level
  `withInstall` calls defeat tree-shaking (the barrel is only cheap because `sideEffects` is declared).
  `app/components.d.ts` is generated by that resolver and committed so a clean checkout typechecks.
- The site is **Material 3 dark only**: `Themes.md3Dark` is spread into an inline `<style>` in `<head>` at build
  time (selector `:root:root`, to beat Varlet's light defaults that arrive later in the stylesheet). No runtime
  theme switching, no client plugin, and no pre-hydration flash — do not "restore" a `prefers-color-scheme` switch.
- TypeScript config is deliberate: `module: "Preserve"` + `moduleResolution: "bundler"` +
  `allowImportingTsExtensions` (paired with `noEmit`), `verbatimModuleSyntax`, `types: ["node"]` only — no DOM lib.
- Strictness is enforced: `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`. Dead code fails `pnpm typecheck`.
- **Windows-only at runtime**: `runCli` rejects any non-`win32` platform (native SkiaSharp dependency). Pure logic
  (path resolution, rules, zip parsing) is platform-agnostic and testable anywhere.
- `GENSHIN_DIR` (or `--input`) is mandatory for `build_map`/`export`; `.env` provides it locally and is
  **not** covered by `.gitignore` — keep machine paths/secrets out of it if the repo is shared.
- `.gitattributes` forces `text=utf-8 eol=lf`; keep LF on all text files (including `.ts`, `.json`, `.md`).
- Never hand-edit `.parse/`, and never delete it to "start clean": the extracted CLI and especially
  `maps/assets_map.map` are reusable caches that cost a full game rescan to recreate.

## Testing & QA

- **There is no test suite, no runner config, no CI, and no lint/format tooling.** The single automated check is
  `pnpm typecheck` — akasha via `tsc --noEmit`, the site via `nuxt typecheck`, which also validates the generated
  `app/components.d.ts` component/prop types.
- Manual smoke procedure (Windows + real game install + `akasha init` already done). Every command except
  `--help`/`--version` prints a per-step `耗时统计` at the end and writes a log mirroring the terminal output to
  `<workDir>/logs/<command>-<stamp>.log` (`--silent` only mutes the terminal, the log is always written):
  1. `pnpm akasha --help` / `--version` — no external dependencies, no run log.
  2. `pnpm akasha export --group logo --out .parse/tmp-check` against the **existing** `.parse/maps/assets_map.map` — the
     normal verification loop (seconds, no rescan; `--out` keeps the shared `.parse/export/` cache untouched).
  3. Only when the map itself is the subject of the change: `pnpm akasha build_map --input '<blocks>/00'` into a
     throwaway `--work-dir` (e.g. `--work-dir .parse/tmp-subset`, delete that dir afterwards) instead of overwriting
     the shared map.
  4. Full-set expectation: exporting with the default rules from a complete map yields **2793 PNGs** under
     `.parse/export/Texture2D/` (10 `Logo_*`, 845 `UI_EmotionIcon*`, 53 `UI_EmotionTagIcon_*`, 694
     `UI_AvatarIcon_*`, 120 `UI_Gacha_AvatarImg_*`, 297 `UI_MapBack_*`, 593 `UI_NameCardPic_*`, 181
     `UI_ChapterIcon_*`) — verify by file count and md5, not by rebuilding the map or re-exporting the whole tree.
  5. Single-asset baseline: `^UI_EmotionTagIcon_46$` → md5 `83116143470252985a54a6098af1a0b2`.
  6. `pnpm akasha emoji` — no game install needed; the first run pulls every TextMap shard (~348MiB into
     `.parse/dimbreath/`, ~47s here), later runs reuse the cache (~5s; `--force` refetches). Expect `15 种语言`,
     `51 个表情包 / 827 个表情`, `877/878 条文案` per language (RU/TH each merge two disjoint shards), an
     `.parse/emoji/emoji.json` identical to a hand merge of the two sheets, and `.parse/emoji/texts/<LANG>.json`
     (24–38KB each) identical to a hand join over the referenced hashes (13,155 of 13,170 hash×language pairs
     resolve). `TextMap_Medium*` is a lossy subset: `UI_EmotionTagIcon_51`'s name hash `4108338941` is absent from
     all of them (it exists in the full `TextMapEN.json`), so it is missing from every `texts/*.json` and warns —
     upstream data, not a bug.
  7. `pnpm akasha pyramid` — no game install needed (it reads `.parse/export/Texture2D/`, so run `export` first);
     expect **4 个 region / 1670 块瓦片 / 34 MiB / ~58 s** and **no "整块透明" warning**. The tile set is exactly the
     interesting part, so verify it against disk rather than eyeballing:
     `bun -e` a throwaway script that compares `levelTiles(gridOf(region, map.json.regions[region]), R)` (from
     `src/map-tiles.ts`) and `levelTiles` (from `packages/site/app/utils/map-geometry.ts`) with the `.webp` names on
     disk for every region × level — all three must be equal. Per-level expectation for the current assets:
     Teyvat 2048:688 1024:616 512:154 256:55 128:21 64:9 32:4 16:1, AbyssalPalace 1024:36 512:9 256:4 64/32/16:1,
     DeepSea 1024:8 512:2 256:2 128/64/32/16:1, TheChasm 1024:36 512:9 256:4 64/32/16:1. Cheap correctness check that
     needs no browser: compare against a reference pyramid by decoding both sides and masking on alpha — R2048/R1024
     tiles must be pixel-identical (0.000/255) because they are plain crops, and the coarse levels only differ by the
     resampling kernel (≈0.2–2.3/255; a wrong layout would be >50).
  8. `pnpm akasha upload` — needs the `R2_*` vars; from an empty remote expect **4480 objects** (`emoji.json` +
     15 texts + `map.json` + 2793 PNGs from `.parse/export/` + 1670 map tiles) under `Static/GI/{formatted,binary}/`,
     an immediate second run uploading 0, and `--force` re-sending everything. (`.parse/export/` is walked
     recursively, so any stray subdirectory there — e.g. an Explorer-made `Texture2D - 副本` copy — is uploaded too.)
     To check the key mapping without touching the bucket, point `R2_ENDPOINT` at a local stub that answers
     ListObjectsV2 with an empty result and logs every `PUT`: the run must end with
     `…/formatted/map.json` and 1670 `…/binary/MapTile/<region>/<R>/<gx>_<gy>.webp` paths.
- Site smoke test（按全局约定：只有必要时、或用户要求 / 报告问题时才真的打开浏览器；能用 `pnpm typecheck` +
  构建产物核对就不开）—— `pnpm site`, or serve the `pnpm site:build` output (`packages/site/.output/public`) statically,
  on **`http://localhost:3000`**: that origin is what the bucket's CORS rules allow, so any other port/domain needs
  adding there first. Expect the app bar (title `原神资料站`), a nav with **表情包** (`` `/` ``) and **地图**
  (`/map`), and — on the emoji page — the language menu plus a horizontally scrolling strip of **51 pack tabs**
  with the active one underlined, **16** emoji per pack with captions, images from `…/binary/Texture2D/`, and the
  `n / 827 个表情 · m / 51 个包` counter. Clicking a tab, picking a language and typing in the search field must each
  update tabs + panel + counter (search matches text, icon name or pack name), `←`/`→` must move to the previous/next
  pack and focus it, and the page must render Material 3 dark **even when the OS is in light mode** (the built
  `index.html` carries the vars — look for `:root:root{`). The grid only mounts a chunk at a time (the first 120
  tiles, then the 「显示更多」 row continues it as it scrolls into view — that button is also the manual fallback);
  changing pack/language/search must restart it from the first chunk. Switching language must refetch only
  `texts/<LANG>.json` (the config is language-independent and its request must not repeat). The map page (`/map`,
  reachable directly — the built output has `map/index.html`) draws the region fitted into a canvas (drag to pan,
  wheel to zoom around the cursor, double-click to zoom in) with a panel showing the region picker, the level in
  px/cell and the resident-tile count;
  switching region refits, and a tile that is still downloading must never show as a blank frame — its coarser
  ancestor paints instead.
  Without a browser: `pnpm site:build` must succeed and emit `.output/public/{index,200,404}.html` plus
  `map/index.html`; the map page's lazy chunk must contain the tile URL shape (`binary/MapTile`) and the manifest URL
  (`formatted/map.json`), the emoji page's chunk `formatted/emoji.json`, and `grep -o ':root:root{'` on any of those
  HTML files proves the theme survived.
- Symptoms that look like bugs but are not: `akasha export` over an already-populated tree prints
  `Nothing exported. N assets skipped (not extractable or files already exist)` even when it did write a file (the
  summary counts matched assets, not writes — verified by deleting one PNG: 2792 files, re-run, 2793 files, same
  md5); filters matching nothing make the upstream binary throw
  `IndexOutOfRangeException`; upstream does not split comma-separated `--types` (the wrapper emits one flag per
  type); in PowerShell `--map_op AssetMap,Load` needs quoting.
- If tests are ever added: `bun test` fits the mandated runtime, but keep them hermetic — no `GENSHIN_DIR`, no
  downloaded exe. Only pure modules (`zip.ts`, `genshin.ts` resolution, `rules.ts`, and the geometry half of
  `map-tiles.ts`/`map-geometry.ts` — the two must stay in lockstep) are worth unit tests; the external-binary paths
  stay manual smoke checks.
