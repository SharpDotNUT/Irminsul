# Repository Guidelines

## Project Overview

Irminsul is a private Bun + pnpm workspace whose only package, `parse`, is a thin TypeScript CLI with two upstream
sources: the external **AnimeStudio CLI** (`AnimeStudio.CLI.exe`, a `net10.0-windows` .NET build) that extracts
assets from Genshin Impact's AssetBundle shards, and the **DimbreathBot/AnimeGameData** JSON dumps used for
localized emoji metadata:

1. `parse init` — download + extract the AnimeStudio CLI build into the work dir.
2. `parse build_map` — scan the game's `blocks/` folder and build `assets_map.map` (MessagePack index).
3. `parse export` — resolve the map and export selected `Texture2D` assets to PNG (by default into `<workDir>/export/`).
4. `parse emoji` — merge both `Emoji*ExcelConfigData` sheets into one config (texts stay hash references) and
   write one hash→text file per language from every `TextMap_Medium*` shard (RU/TH shards merged).
5. `parse upload` — push those products plus the PNGs exported into `<workDir>/export/` to Cloudflare R2 under
   `Static/GI/`, split into `formatted/` (JSON/text) and `binary/` (images), skipping objects already there with the
   same size.

The wrapper adds flag ergonomics, environment-based path resolution, rule-driven asset selection, JSON shape
normalization, download fallback and an R2 upload step. Actual asset parsing is entirely the upstream binary's
job — do not reimplement decoding here.

## Architecture & Data Flow

Layers (strictly one direction: `cli.ts` → `commands/` → shared modules):

| Layer | Module | Role |
| --- | --- | --- |
| Entry | `packages/parse/src/cli.ts` | hand-rolled flag parser, `COMMANDS` registry, `printUsage`, single try/catch → `process.exitCode = 1` |
| Commands | `src/commands/{init,build_map,export,emoji}.ts` | `xxxCommand(ctx, options)` → `Promise<void>`; argv assembly for the upstream binary |
| Paths | `src/context.ts` | `Context {workDir, game, silent}`, the `WORK_PATHS` work-dir layout, `resolveWorkDir` (`--work-dir` > `PARSE_WORK_DIR` > `<project root>/.parse`) |
| Inputs | `src/genshin.ts` | `resolveScanRoot` (`--input` > `GENSHIN_DIR`) → the `blocks` folder or a single `.blk` |
| Exec | `src/anime-studio.ts` | CLI acquisition (`downloadCliArchive`: nightly.link → GitHub artifact fallback), `CLI_EXE`, `findCli`, `cliVersion`, `runCli` (win32 guard) |
| Download / zip | `src/download.ts`, `src/zip.ts` | generic `downloadTo` + `progressReporter` + `downloadCached` + `resolveArtifact`, zip magic check + dependency-free zip extractor |
| Export only | `src/rules.ts` + `src/rules.json` | named regex groups → `patternsForGroups` |
| Emoji only | `src/emoji.ts` | DimbreathBot URLs + `mergeConfigData`/`mergeTextMaps`/`buildTexts` (config merge, container/field-name drift, RU/TH shard merge, per-language split) |
| Upload | `src/s3.ts` | `Bun.S3Client` facade: `R2_*` env config, paged prefix listing, single-file upload (`Content-Type` from the extension) |
| Logging | `src/log.ts` | `log` (suppressed by `--silent`), `warn` (never suppressed) |

Data flow per command:

- **init**: `downloadCliArchive` fetches the archive → nightly.link URL, on failure the latest successful `master`
  GitHub Actions run's `AnimeStudio-net10` artifact (needs `GITHUB_TOKEN`/`GH_TOKEN`/`gh auth`) → PK magic check
  (`assertZipFile`) → `extractZip` (strips the artifact's single root folder) → `<workDir>/anime-studio/`.
- **build_map**: `resolveScanRoot` → spawn `<blocks> maps --game GI --map_op AssetMap --map_type MessagePack --types <T>…`
  with `cwd = workDir` → `<workDir>/maps/assets_map.map`.
- **export**: rule groups → regex list written to `<workDir>/names.txt` → spawn
  `<blocks> <out> --map_op AssetMap,Load --map_name <map> --types Texture2D --names names.txt --group_assets ByType --export_type Convert`
  → `<out>/Texture2D/*.png`, `<out>` = `--out` or `<workDir>/export/` (the reusable cache `parse upload` reads).
- **emoji**: both `ExcelBinOutput` sheets + every `TextMap_Medium<suffix>` shard (raw.githubusercontent `main`;
  RU = `RU_0`+`RU_1`, TH = `TH_0`+`TH_1`) → `<workDir>/dimbreath/` (raw cache; `--force` refetches) →
  `mergeConfigData` folds the emoji rows into their sets (`order`-sorted) and keeps `nameTextMapHash` /
  `contentTextMapHash` as **hash references** → `<out>/emoji.json`; each shard is parsed, filtered down to the
  878 referenced hashes and dropped (`mergeTextMaps`, so ~350MB of input never sits in memory at once) →
  `buildTexts` → `<out>/texts/<LANG>.json` = `{"<hash>": "文案"}` (`<out>` = `--out` or `<workDir>/emoji/`).
- **upload**: `<emojiDir>` (`--emoji` or `<workDir>/emoji`) → `Static/GI/formatted/**`, `<imagesDir>` (`--images`,
  default `<workDir>/export` — the tree `parse export` writes) walking every file recursively →
  `Static/GI/binary/**`; the whole `Static/GI/` prefix is listed once up front and objects whose size already
  matches are skipped.

Two upstream facts drive most of the code: reading an existing map requires the composed flag
**`--map_op AssetMap,Load`** (`AssetMap` alone rebuilds), and map `Source` entries are absolute paths, so a map
built against a moved game folder is dead.

## Key Directories

- `packages/parse/src/` — all source; one file per subcommand under `src/commands/`, shared modules at `src/` root.
- `packages/parse/src/rules.json` — export selection rules as **data** (regex groups + `default` list). Extend the
  default export set here, not in TypeScript.
- `.parse/` — gitignored runtime work dir: `anime-studio/` (extracted CLI), `maps/assets_map.map`, `names.txt`,
  `downloads/`, `export/` (`parse export` 的 PNG 产物，upload 的来源), `dimbreath/` (raw upstream emoji JSON,
  ~348MiB) and `emoji/` (products: `emoji.json` + `texts/<LANG>.json`). Never edit by hand; refresh the CLI with
  `parse init --force`, rebuild the map only when the game folder actually changed, refetch the Dimbreath JSON with
  `parse emoji --force` (its cache is only as fresh as the last run), and **leave `maps/` and `export/` alone** (see
  the warning below).

> **`.parse/maps/assets_map.map` and `.parse/export/` are expensive caches — do not delete or re-create them
> casually.** A full `build_map` reads every `.blk` in the game folder (1925 files / ~54 GB ⇒ ~8 min on this
> machine, and hours on larger installs). During development: keep `.parse/maps/assets_map.map` in place, run
> `parse export` against it (seconds, no rescan) to exercise changes, and when a fresh index really is needed build
> a subset with `parse build_map --input '<blocks>/00'` (or a single `.blk`) instead of rescanning everything. Never
> treat deleting `.parse/` or re-running `build_map` as a routine "clean" step; note that widening `--types`,
> changing the game folder, or moving the install invalidates the cached `Source` paths and forces a full rebuild.
>
> `.parse/export/` is the same kind of cache: it can only be rebuilt while the map — whose `Source` paths point
> back into the game install — and the game folder itself are still in place, and it is exactly what `parse upload`
> reads. Re-exporting is incremental: deleting a PNG and re-running the same rules regenerates it byte-identically
> (verified on `UI_EmotionTagIcon_46.png`, md5 `83116143470252985a54a6098af1a0b2`, 889 → 890 files), so keep the
> directory and re-export only when the rule set or the extracted assets actually changed. To try an experiment use
> `--out .parse/tmp-check` instead of the shared tree.

- `.agent/skills/anime-studio-assetmap-export/SKILL.md` — upstream CLI semantics, tested pitfalls and a known-good
  md5 baseline. Its absolute paths predate the `.parse/` layout; treat the flags as authoritative, the paths as stale.

## Development Commands

```bash
pnpm install                                   # workspace install (pnpm@11.5.0 pin)
pnpm typecheck                                 # pnpm -r typecheck → tsc --noEmit — the only automated gate
pnpm parse --help                              # command list, env vars, rule groups
pnpm parse <cmd> --help                        # per-command flags
pnpm parse init                                # download/extract AnimeStudio CLI (idempotent; --force to refresh)
pnpm parse build_map                           # full game scan (~8 min, 1925 blk / 54 GB) — reuse this map, do not rebuild casually
pnpm parse build_map --input '<blocks>/00'     # subset scan (fast iteration)
pnpm parse export                              # 默认规则 → .parse/export/Texture2D/*.png（复用 map，秒级；这份产物是 upload 的来源）
pnpm parse export --out .parse/tmp-check       # 试验性导出到独立目录，别动共享的 export/
pnpm parse export --group logo --pattern '^UI_ItemIcon_1\d+$' --export-type Raw
pnpm parse emoji                               # → .parse/emoji/{emoji.json,texts/<LANG>.json}（15 语言；首次约 350MB）
pnpm parse upload                              # emoji 产物 + 贴图目录 → R2 Static/GI/{formatted,binary}/（按前缀跳过已存在）
```

Equivalent direct form: `bun run packages/parse/src/cli.ts <cmd> [flags]` (or `bun run src/cli.ts` inside
`packages/parse`). There is **no build, test, lint or format script** — do not introduce a bundler or transpile step.

## Code Conventions & Common Patterns

- **ESM + explicit extensions**: `import { x } from "./mod.ts"`, `import type { … }`; always use `node:` prefixes.
- **Language split**: identifiers, comments and file names are English; every user-facing string (help, logs,
  errors, `rules.json` descriptions) is Chinese.
- **Errors**: `throw new Error("<what went wrong>，<actionable next step>")` (e.g. `请先运行: parse init`). Only
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
| `packages/parse/src/cli.ts` | single source of the CLI surface (commands, flags, enums, help text, error handling) |
| `packages/parse/src/context.ts` | work-dir contract (`WORK_PATHS` layout, `projectRoot()` walks up for `pnpm-workspace.yaml`) |
| `packages/parse/src/genshin.ts` | `GENSHIN_DIR` → `blocks` resolution rules (`*_Data` preference order) |
| `packages/parse/src/anime-studio.ts` | CLI acquisition (`downloadCliArchive`: nightly.link → GitHub artifact fallback), upstream argv construction, `cwd = workDir`, win32 guard, exit-code hints |
| `packages/parse/src/rules.json` | default export selection (3 groups: `logo`, `emotion-icon`, `emotion-tag-icon`) |
| `packages/parse/src/emoji.ts` | DimbreathBot file/language tables (`TEXT_MAP_LANGS` 分片) + `mergeConfigData`/`mergeTextMaps`/`buildTexts` (tolerates upstream shape drift) |
| `packages/parse/src/zip.ts` | zip64-capable extractor + `assertZipFile` magic check; traversal guard; no external `tar`/`Expand-Archive` |
| `packages/parse/src/s3.ts` | `parse upload` 的通道：`createS3()` 读 `R2_*` 环境变量 → 分页 `listKeys` + `upload`；只声明用到的 `Bun.S3Client` 表面（tsconfig 无 bun-types） |
| `packages/parse/tsconfig.json` | the only tsconfig; all strictness lives here |
| `package.json` (root) | workspace scripts `parse`, `typecheck`; `engines.bun`, `packageManager` |
| `.env` | local `GENSHIN_DIR` + `R2_*` upload config; Bun auto-loads it for `bun run`/`bun` invocations |
| `.agent/skills/anime-studio-assetmap-export/SKILL.md` | upstream `--map_op`/filter semantics and pitfalls |

## Runtime/Tooling Preferences

- **Bun ≥ 1.3.14 is the runtime** (`engines.bun`); sources execute unmodified from `src/` — `bin.parse` points at
  `./src/cli.ts` and `noEmit` forbids a `dist/`. pnpm 11.5.0 is install-only.
- Object storage goes through Bun's built-in `Bun.S3Client` (`src/s3.ts`) — no AWS SDK dependency; the missing Bun
  types are declared locally there instead of relaxing `types: ["node"]`.
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
  `pnpm typecheck` (or `cd packages/parse && tsc --noEmit`).
- Manual smoke procedure (Windows + real game install + `parse init` already done):
  1. `pnpm parse --help` / `--version` — no external dependencies.
  2. `pnpm parse export --group logo --out .parse/tmp-check` against the **existing** `.parse/maps/assets_map.map` — the
     normal verification loop (seconds, no rescan; `--out` keeps the shared `.parse/export/` cache untouched).
  3. Only when the map itself is the subject of the change: `pnpm parse build_map --input '<blocks>/00'` into a
     throwaway `--work-dir` (e.g. `--work-dir .parse/tmp-subset`, delete that dir afterwards) instead of overwriting
     the shared map.
  4. Full-set expectation: exporting with the default rules from a complete map yields **890 PNGs** under
     `.parse/export/Texture2D/` (10 `Logo_*` + 880 emotion icons) — verify by file count and md5, not by rebuilding
     the map or re-exporting the whole tree.
  5. Single-asset baseline: `^UI_EmotionTagIcon_46$` → md5 `83116143470252985a54a6098af1a0b2`.
  6. `pnpm parse emoji` — no game install needed; the first run pulls every TextMap shard (~348MiB into
     `.parse/dimbreath/`, ~47s here), later runs reuse the cache (~5s; `--force` refetches). Expect `15 种语言`,
     `51 个表情包 / 827 个表情`, `877/878 条文案` per language (RU/TH each merge two disjoint shards), an
     `.parse/emoji/emoji.json` identical to a hand merge of the two sheets, and `.parse/emoji/texts/<LANG>.json`
     (24–38KB each) identical to a hand join over the referenced hashes (13,155 of 13,170 hash×language pairs
     resolve). `TextMap_Medium*` is a lossy subset: `UI_EmotionTagIcon_51`'s name hash `4108338941` is absent from
     all of them (it exists in the full `TextMapEN.json`), so it is missing from every `texts/*.json` and warns —
     upstream data, not a bug.
  7. `pnpm parse upload` — needs the `R2_*` vars; from an empty remote expect **906 objects** (`emoji.json` +
     15 texts + 890 PNGs from `.parse/export/`) under `Static/GI/{formatted,binary}/`, an immediate second run
     uploading 0, and `--force` re-sending everything.
- Symptoms that look like bugs but are not: `parse export` over an already-populated tree prints
  `Nothing exported. N assets skipped (not extractable or files already exist)` even when it did write a file (the
  summary counts matched assets, not writes — verified by deleting one PNG: 889 files, re-run, 890 files, same
  md5); filters matching nothing make the upstream binary throw
  `IndexOutOfRangeException`; upstream does not split comma-separated `--types` (the wrapper emits one flag per
  type); in PowerShell `--map_op AssetMap,Load` needs quoting.
- If tests are ever added: `bun test` fits the mandated runtime, but keep them hermetic — no `GENSHIN_DIR`, no
  downloaded exe. Only pure modules (`zip.ts`, `genshin.ts` resolution, `rules.ts`) are worth unit tests; the
  external-binary paths stay manual smoke checks.
