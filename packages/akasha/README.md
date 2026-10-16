# @irminsul/akasha

原神资产流水线的命令行工具，共六步：

- **init** —— 下载并解压 AnimeStudio CLI（真正负责解包的那个二进制）。
- **build_map** —— 扫描游戏 `blocks/`，构建资源索引 `assets_map.map`。
- **export** —— 用索引按规则把 `Texture2D` 导出为 PNG。
- **emoji** —— 合并 DimbreathBot/AnimeGameData 的两份表情配置，并按语言输出 hash→文案表。
- **pyramid** —— 把导出出来的 `UI_MapBack` 贴图切成 WebP 瓦片金字塔，供站点平移缩放浏览。
- **upload** —— 把上面三组产物推到 Cloudflare R2。

它只是这些上游的薄封装：参数拼装、路径解析、JSON 整形；解包本身不在这个仓库里实现。

```bash
pnpm akasha <command>                          # 仓库根
bun run packages/akasha/src/cli.ts <command>   # 等价直连
cd packages/akasha && pnpm akasha <command>    # 包内
```

公共选项：`--work-dir <目录>`（默认 `<项目根>/.parse`）、`--game <GI>`、`--silent`、`--help`。

## 命令一览

| 命令 | 作用 | 产物 |
| --- | --- | --- |
| `init` | 下载并解压 AnimeStudio CLI | `.parse/anime-studio/AnimeStudio.CLI.exe` |
| `build_map` | 扫描游戏 `blocks/`，构建 MessagePack 索引 | `.parse/maps/assets_map.map` |
| `export` | 把选中的 `Texture2D` 导出为 PNG | `.parse/export/Texture2D/*.png` |
| `emoji` | 合并表情配置 + 每语言文案表 | `.parse/emoji/{emoji.json,texts/<LANG>.json}` |
| `pyramid` | 把导出的 `UI_MapBack` 贴图切成 WebP 瓦片金字塔 | `.parse/pyramid/{map.json,<region>/<R>/*.webp}` |
| `upload` | 把产物推到对象存储 | R2 `Static/GI/{formatted,binary}/**` |

## 耗时与日志

每个命令都会在终端逐步打印耗时（`12.34s  导出资产`），结束时给出每一步的汇总、合计与**本进程**峰值内存
（上游 CLI 是独立子进程，它的内存不在这个数字里）：

```
耗时统计:
     1ms  写出 names.txt
   2.55s  导出资产
   2.56s  合计  ·  本进程峰值内存 85 MiB
日志: <work-dir>/logs/export-20260929-135227.log
```

同一次运行的输出（耗时步骤、warning、各命令自己的日志行）会同时写进
`<work-dir>/logs/<命令>-<本地时间>.log`；上游 CLI 直通到终端的那部分不在这里面。这是回看“慢在哪一步”的地方，
一次运行也就几 KB，可以随时删。`--silent` 只压终端，日志照写。

## init

```bash
pnpm akasha init [--url <zip>] [--force]
```

从 nightly.link 取 `master` 分支的构建并解压；站点不可用时自动回落到最近一次成功的 GitHub Actions 产物
（这一步需要鉴权：`GITHUB_TOKEN` / `GH_TOKEN` 或 `gh auth login`）。下载后会先确认是不是合法 zip，避免把错误页
当压缩包解。装好后只打印路径与版本，`--force` 才会重新下载。

## build_map

```bash
pnpm akasha build_map [--input <blocks>] [--types <Type[,Type]>] [--ai-file <json>]
```

- `--input` 可以是 `blocks` 目录、游戏目录或单个 `.blk`；不传则读 `GENSHIN_DIR`。
- `--types` 默认 `Texture2D`，多个类型用逗号分隔。
- **全量很贵**：本机 1925 个 `.blk` / 约 54 GB ⇒ 约 8 分钟。迭代时用 `--input '<blocks>/00'` 只扫子集。

## export

```bash
pnpm akasha export [--out <dir>] [--map <map>] [--group <name>] [--pattern <regex>] [--all] \
                   [--types <Type[,Type]>] [--export-type Convert|Raw|Dump|JSON] \
                   [--group-assets ByType|ByContainer|BySource|None] [--input <blocks>]
```

- `--out` 默认 `.parse/export/`，`--map` 默认 `.parse/maps/assets_map.map`。
- 内置规则组（正则见 `pnpm akasha --help`）：`logo`、`emotion-icon`、`emotion-tag-icon`、`avatar-icon`
  （`UI_AvatarIcon_` 前缀）、`gacha-avatar-img`（`UI_Gacha_AvatarImg_`）、`map-back`（`UI_MapBack_`）、
  `namecard-pic`（`UI_NameCardPic_`）、`chapter-icon`（`UI_ChapterIcon_`）。
- 不传 `--group` / `--pattern` 时用 `rules.json` 的 `default`（即上面全部 8 组）；`--pattern` 是**追加**的正则，
  `--all` 则跳过过滤、导出索引里全部 `Texture2D`。
- 默认规则下的产物（本机实测 1925 个 `.blk` 的完整索引）：**2793 张 PNG** = 10 张 `Logo_*`、845 张
  `UI_EmotionIcon*`、53 张 `UI_EmotionTagIcon_*`、694 张 `UI_AvatarIcon_*`、120 张 `UI_Gacha_AvatarImg_*`、
  297 张 `UI_MapBack_*`、593 张 `UI_NameCardPic_*`、181 张 `UI_ChapterIcon_*`。
- 重复导出是增量的：已有的文件会被跳过，删掉的 PNG 会被按位重建。

## emoji

```bash
pnpm akasha emoji [--lang <语言[,语言]>] [--out <目录>] [--force]
```

- 语言默认全部 15 种；`RU` / `TH` 在上游各拆成两个分片，这里会自动合并。
- 原始 JSON 缓存在 `.parse/dimbreath/`（首次约 348 MiB，本机约 47 秒），之后复用（秒级）；`--force` 重拉。
- 输出 `emoji.json`（文案仍是 hash 引用）+ `texts/<LANG>.json`（hash → 文案）。上游 `TextMap_Medium*` 是有损
  子集，个别 hash（如 `UI_EmotionTagIcon_51` 的 `4108338941`）全语言都缺，会打 warning，不是 bug。

## pyramid

```bash
pnpm akasha pyramid [--input <export 目录>] [--out <目录>] [--region <名称>]
```

把 `akasha export --group map-back` 导出的贴图（默认读 `<work-dir>/export/Texture2D/UI_MapBack_*.png`）
切成标准瓦片金字塔，输出到 `<work-dir>/pyramid/`：

```
pyramid/
  map.json                  # 清单：一格多少世界像素 + 每个 region 的贴图坐标与原生尺寸
  Teyvat/2048/0_0.webp      # {region}/{R}/{gx}_{gy}.webp，R = 该档每格多少像素
  Teyvat/1024/0_0.webp
  …
```

- **不用手写资源清单**：region 与坐标从文件名解析（`UI_MapBack[_Region]_x_y`），原生尺寸直接读 PNG 文件头；
  `UI_MapBack_None.png`（64×64 空占位）会被跳过。所以先跑 export，再跑这里。
- 档位 `R` 从 2048 逐倍减半到 16：一格图片的像素尺寸是**该格的细节上限**，不是覆盖范围 —— 图片永远铺满
  2048 世界像素的一格，所以一格只在 `R ≤ 自己的原生尺寸` 的档位上出瓦片，细档天然稀疏。
- 需要 `Bun.Image`（Bun ≥ 1.3.14）做解码/重采样/WebP 编码，额外依赖为零。
- 本机实测：1670 块瓦片 / 34 MiB / 约 58 秒（源图 296 张 PNG / 248 MiB）。
- 重复运行会整份重切（不增量）；`--region` 只切一个区域、`--out` 换个目录做实验。

## upload

```bash
pnpm akasha upload [--emoji <dir>] [--images <dir>] [--pyramid <dir>] [--prefix <前缀>] [--force]
```

- 凭据只从环境变量读：`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET_NAME`、`R2_ENDPOINT`
  （`.env` 由 Bun 自动加载）。
- 默认传三组：`--emoji`（默认 `.parse/emoji`）→ `<前缀>/formatted/**`，`--images`（默认 `.parse/export`）→
  `<前缀>/binary/**`，`--pyramid`（默认 `.parse/pyramid`）→ 瓦片 `<前缀>/binary/MapTile/**`、清单
  `<前缀>/formatted/map.json`；前缀默认 `Static/GI`，源目录下的相对路径原样保留。
- 上传前会按前缀读一次远端列表，**同 key 且字节数相同就跳过**，避免重复上传；`--force` 全部重传。

## 远端布局

```
Static/GI/formatted/emoji.json
Static/GI/formatted/texts/CHS.json
Static/GI/formatted/map.json
Static/GI/binary/Texture2D/UI_EmotionIcon1.png
Static/GI/binary/MapTile/Teyvat/2048/0_0.webp
```

## 注意

- `.parse/maps/assets_map.map` 与 `.parse/export/` 是昂贵缓存，别随手删或重导：索引重建要整份重扫游戏目录，
  且索引里存的是绝对路径（游戏目录一移动就作废）；`.parse/export/` 是 `upload` 的输入，只有在索引与游戏目录
  都还在时才能重建。实验请用独立目录（`--out .parse/tmp-check`）。
- 过滤条件没命中任何资产时上游会抛 `IndexOutOfRangeException`；PowerShell 下 `--map_op AssetMap,Load`
  这个值要加引号。

开发约定（分层、代码风格、冒烟清单）见仓库根的 `AGENTS.md`。
