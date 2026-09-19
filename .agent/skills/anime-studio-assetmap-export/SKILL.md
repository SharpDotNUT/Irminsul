---
name: anime-studio-assetmap-export
description: AnimeStudio CLI 的 AssetMap 用法与实测坑：如何对 GI/hk4e blocks 建 assets_map.map，如何用 --map_op AssetMap,Load 从已有 map 精确导出 Texture2D（全部 / 按名字正则 / 按名单文件），以及 --types/--names/--containers/--map_name/--group_assets/--export_type 的确切语义。当用户要导出 Unity 贴图或其它资产、排查“加载了 AssetMap 但什么都没导出/直接崩溃”、或询问 --map_op 取值含义时使用。
---

# AnimeStudio：用 AssetMap 导出 Texture2D / 指定资产

## 1. 本机环境（已实测）

| 项 | 值 |
|---|---|
| CLI | `.\AnimeStudio.CLI.exe`（相对项目根 `C:\Users\Kuriyona\Desktop\ciallo\AnimeStudio-net10-02994d5c30a43d0d5c5124557ec361ccbbad24c0`） |
| DLL 目录 | `bin\`（`AnimeStudio.dll` / `AnimeStudio.CLI.dll`） |
| CABMap 目录 | `Maps\`（`DumpCABMap` 固定写这里，与 `--map_name` 无关） |
| 已有 AssetMap | `t.map\assets_map.map`（MessagePack，110MB） |
| 游戏 | `--game GI`，B站客户端 `C:\miHoYo\hk4e_bilibili\YuanShen_Data\StreamingAssets\AssetBundles\blocks` |
| 数据规模 | 16 个子目录（`00`…`15`），约 8000 个 `.blk`，单个 30–50MB |

配置默认值在 `bin\AnimeStudio.CLI.dll.config`：`minimalAssetMap=True`、`convertTexture=True`、`convertType=Png`、
`types` 里 `Texture2D` 为 `{Parse:true, Export:true}`。

## 2. 心智模型（最关键的一条）

`--map_op` 是 `[Flags] MapOpType`，位值：

| 名字 | 值 | 行为 |
|---|---|---|
| `None` | 0 | 直接扫 input 导出（不用 map） |
| `Load` | 1 | **只加载 CABMap** 并解析依赖；**不读 AssetMap** |
| `CABMap` | 2 | 建 CABMap（写 `Maps\<name>.bin`） |
| `AssetMap` | 4 | **建** AssetMap（写 `<output>\<name>.map`） |
| `Both` | 8 | 同时建 CABMap + AssetMap |
| `All` | 9 = `Both\|Load` | 建两种 map + 再扫 input 导出（**不读已有 map**） |

读取已有 AssetMap 的唯一开关是 **`AssetMap|Load` = 5**（无对应具名成员，所以写数值或逗号组合）。
源码依据：`AnimeStudio.CLI/Program.cs` 里只有 `o.MapOp.HasFlag(MapOpType.AssetMap) && o.MapOp.HasFlag(MapOpType.Load)`
才调用 `AssetsHelper.ParseAssetMap(...)`，返回值（map 中每条 entry 的 `Source` 绝对路径去重）替换掉 input 文件列表。

`ParseAssetMap` 做的事：读 map → 按 `--types`/`--names`/`--containers` 过滤 entry → 收集 `Source`。
过滤器在**解析阶段和导出阶段各生效一次**，所以三件套必须同时带上。

## 3. 建图（一次性，之后可反复复用）

```bat
:: 全类型建图（默认 --map_type XML，必须显式指定 MessagePack）
.\AnimeStudio.CLI.exe C:\miHoYo\hk4e_bilibili\YuanShen_Data\StreamingAssets\AssetBundles\blocks .\t.map ^
  --game GI --map_op AssetMap --map_type MessagePack

:: 只收贴图，图会小很多
.\AnimeStudio.CLI.exe ...\blocks .\t.map --game GI --map_op AssetMap --map_type MessagePack --types Texture2D

:: 想让 Container 变成可读资源路径（否则是数字哈希），加 asset_index.json
.\AnimeStudio.CLI.exe ...\blocks .\t.map --game GI --map_op AssetMap --map_type MessagePack --ai_file <asset_index.json>
```

产物：`<output>\<map_name>.map`（`--map_name` 默认 `assets_map`）。JSON/XML 同理，扩展名 `.json`/`.xml`。

## 4. 从已有 map 导出（本技能核心）

```bat
:: 4.1 导出 map 里的全部 Texture2D
.\AnimeStudio.CLI.exe C:\miHoYo\hk4e_bilibili\YuanShen_Data\StreamingAssets\AssetBundles\blocks .\out_tex ^
  --game GI --map_op AssetMap,Load --map_type MessagePack --map_name .\t.map\assets_map.map --types Texture2D

:: 4.2 导出特定 Texture2D（--names 是正则，大小写不敏感，默认部分匹配）
.\AnimeStudio.CLI.exe ...\blocks .\out_tex ^
  --game GI --map_op AssetMap,Load --map_type MessagePack --map_name .\t.map\assets_map.map ^
  --types Texture2D --names "^UI_EmotionTagIcon_46$"

:: 4.3 一批名字（单参数且指向存在的文件时，按行读作多个正则）
.\AnimeStudio.CLI.exe ...\blocks .\out_tex ^
  --game GI --map_op AssetMap,Load --map_type MessagePack --map_name .\t.map\assets_map.map ^
  --types Texture2D --names .\names.txt

:: 4.4 只想要贴图文件、不要目录分组
... --group_assets None
```

要点：

- `--map_op 5` 与 `--map_op "AssetMap,Load"` 完全等价；**PowerShell 里逗号是数组运算符，必须加引号或直接写 `5`**。
- input 路径在 Load 模式下只被 `Directory.GetFiles` 枚举一次、**不参与选择**；真正加载的 blk 来自 map 里记录的绝对路径。
- `--map_name` 必须是**带 `.map` 扩展名的、相对进程 CWD 的文件路径**（不是相对 output）。
- 没命中任何 entry → `Program.Run` 里 `files[0]` 抛 `System.IndexOutOfRangeException`（CLI 的健壮性 bug），所以先用确定存在的名字试探。

## 5. 输出布局与格式

| 开关 | 取值 | 结果 |
|---|---|---|
| `--group_assets` | `ByType`（默认） | `out\Texture2D\<Name>.png` |
| | `ByContainer` | 按容器路径分目录；GI 未解析容器时退化为按类型 |
| | `BySource` | `<blk>_export\<cab>\...` |
| | `None` | 全部平铺到 out 根 |
| `--export_type` | `Convert`（默认） | PNG（`convertTexture=True` + SkiaSharp） |
| | `Raw` | 原始 `.tex` |
| | `Dump` / `JSON` | 解析后的对象/元数据 |
| `--silent` | — | 关闭日志（大批量导出建议加） |

同名资产出现在多个 blk 时，第二个会被跳过并打印 `assets skipped (not extractable or files already exist)`。

## 6. 过滤器语义

- `--types <Type 列表>`：Unity 类名（`Texture2D`、`Sprite`、`Shader`、`Material`、`TextAsset`、`AudioClip`、`Mesh`、`GameObject`、`Animator`…）。
  每项可写 `Type` / `Type:Parse` / `Type:Export` / `Type:Both`。用 `--types Texture2D` 时同时作为 map-entry 过滤和导出过滤。
  **务必显式带上**：省略即“不过滤类型”，会把 map 里所有类型的 Source 全拉进来（GI 上等于加载几乎所有 blk）。
- `--names <正则…>`：匹配资产名（map 的 `Name` / 导出时的 `asset.Text`）。多个值或一个“名单文件”（每行一个正则）。
- `--containers <正则…>`：匹配 `Container`。**GI 未用 `--ai_file` 建图时 Container 是数字哈希**（如 `492661707`、`-1123042071`），写人类可读路径会匹配不到（然后触发上面那个崩溃）。
- 三类过滤器全部用 `Regex.IsMatch`，忽略大小写，非锚定；建议用 `^…$` 避免误伤。

## 7. 实测坑清单

1. `--map_op Load` / `All` 都不会读 AssetMap（前者只读 CABMap，后者重建），看着“加载成功”其实在扫 input。
2. `--map_name` 漏 `.map` 扩展名 → `FileNotFoundException: Could not find file ...\t.map\assets_map`。
3. 过滤器零命中 → `IndexOutOfRangeException at AnimeStudio.CLI.Program.Run(Options o)`。
4. map 里的 `Source` 是**绝对路径**，游戏目录移动/换机后 map 失效（需重建）。
5. `Maps\<name>.bin`（CABMap）固定写在 CWD 的 `Maps/` 下，不受 output 影响；做实验记得清理。
6. 加载单位是整个 `.blk`（不是 offset 级读取）→ 全量导出会很慢、很吃盘；先按名字/类型缩小。
7. 想按资源路径找资产（`--containers`、`ByContainer`），必须建图时给 `--ai_file`。

## 8. 验证套路（每步都可低成本自证）

```bat
:: 日志里应出现：命中数量级的 “[i/n] Exporting Texture2D: <Name>”
:: 结束行：Finished exporting N assets / Nothing exported.
:: 逐文件比对（与 GUI 已导出的同名 png 应为同一字节）
md5sum out_tex\Texture2D\UI_EmotionTagIcon_46.png Texture2D\UI_EmotionTagIcon_46.png
```

已知基线：`--types Texture2D --names "^UI_EmotionTagIcon_46$"` 命中唯一 blk
`blocks\00\06031170.blk`，输出 1 张 png，md5 = `83116143470252985a54a6098af1a0b2`。

想先确认 map 里有什么，可以对**单个 blk**建小图，再用文本工具查名字：

```bat
.\AnimeStudio.CLI.exe ...\blocks\00\06031170.blk .\o\t7 --game GI --map_op AssetMap --map_type JSON --types Texture2D
python -c "import json;print([e['Name'] for e in json.load(open('o/t7/assets_map.json',encoding='utf-8'))['AssetEntries']][:20])"
```

## 9. 其它可用开关（来自 `.\AnimeStudio.CLI.exe --help`）

`--game`（必填，枚举见 help）、`--unity_version`、`--key <0xNN>`（MiHoYoBinData XOR）、
`--dummy_dlls <dir>`（MonoBehaviour 类型树）、`--logger_flags`、`--silent`、
`--map_type JSON|MessagePack|None|XML`（默认 XML，建图和读图都要显式给对）。

[未实测] GUI（`AnimeStudio.GUI.exe`）自带 Asset Browser，可加载 map 后搜索并勾选导出；交互式挑资产时比自己写正则方便。
